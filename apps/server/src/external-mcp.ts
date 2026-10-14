/** One server-only store for manually connected and agent-plugin-declared MCP servers. */
import { z } from 'zod';
import { boundedJsonSchema, callContextSchema, idSchema } from '@open-marketing/contracts';
import type { CallContext, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { parseAgentPluginMcpConfig } from '@jini-ai/agent-plugins/lifecycle';
import type { McpServerConfig } from '@jini-ai/agent-plugins/lifecycle';
import { addonBoundary, addonFailure } from './addons.js';

/** Configuration never leaves the server. Credentials are referenced, resolved only at dispatch. */
export type ExternalMcpConnection = { connectionId: string; pluginId: string | null; revision: string; enabled: boolean;
    server: McpServerConfig; credentialConnectionId?: string };
/** I-2 binds this to the existing federation session owner; this module creates no transport. */
export interface ExternalMcpSessions {
    reload(required: { context: CallContext; connection: ExternalMcpConnection }): Promise<void>;
    close(required: { context: CallContext; connectionId: string }): Promise<void>;
}
export interface ExternalMcpStore {
    list(required: { context: CallContext }): Promise<Outcome<ExternalMcpConnection[]>>;
    save(required: { context: CallContext; connection: ExternalMcpConnection }): Promise<Outcome<void>>;
    provision(required: { context: CallContext; pluginId: string; revision: string; configuration: unknown }): Promise<Outcome<void>>;
    setPluginEnabled(required: { context: CallContext; pluginId: string; enabled: boolean }): Promise<Outcome<void>>;
    removePlugin(required: { context: CallContext; pluginId: string }): Promise<Outcome<void>>;
    dispose(required: { context: CallContext }): Promise<Outcome<void>>;
}

/** Persistent configuration and activation with one injected federation owner.
 * Save closes the old session before changing bytes; failures leave closed, disabled rows.
 * @example const externalMcp = createExternalMcpStore({ db, observer, sessions });
 * @complexity <=100 rows/scope, <=64 KiB JSON/configuration. Sequential cleanup, no hidden retries.
 */
export function createExternalMcpStore(required: { db: CredentialSqlPort; observer: ObserverPort; sessions: ExternalMcpSessions }): ExternalMcpStore {
    const boundary = <T>(input: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }) => addonBoundary({ ...input, dependencies: required });

    /** Strict row boundary validates transport declarations with Jini before session use. */
    async function listRows(input: { context: CallContext }): Promise<ExternalMcpConnection[]> {
        callContextSchema.parse(input.context);
        const result = await required.db.query({ text: 'SELECT connection_id,plugin_id,revision,enabled,configuration FROM addon_external_mcp WHERE owner_id=$1 AND workspace_id=$2 ORDER BY connection_id LIMIT 101', values: [input.context.scope.ownerId, input.context.scope.workspaceId] });
        if (result.rows.length > 100) throw new RangeError('MCP connection cap');
        return result.rows.map(row => parseConnection({ value: { connectionId: row.connection_id, pluginId: row.plugin_id,
            revision: row.revision, enabled: z.union([z.literal(0), z.literal(1)]).parse(row.enabled) === 1,
            ...z.record(z.string(), z.unknown()).parse(JSON.parse(z.string().max(65536).parse(row.configuration))) } }));
    }

    async function writeRow(input: { context: CallContext; connection: ExternalMcpConnection }): Promise<void> {
        const row = parseConnection({ value: input.connection });
        await required.db.query({ text: 'INSERT INTO addon_external_mcp (owner_id,workspace_id,connection_id,plugin_id,revision,enabled,configuration) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,workspace_id,connection_id) DO UPDATE SET plugin_id=excluded.plugin_id,revision=excluded.revision,enabled=excluded.enabled,configuration=excluded.configuration',
            values: [input.context.scope.ownerId, input.context.scope.workspaceId, row.connectionId, row.pluginId, row.revision, Number(row.enabled), JSON.stringify({ server: row.server, credentialConnectionId: row.credentialConnectionId })] });
    }

    /** Publish disabled first, reload last. A missing session owner refuses enable, never fakes it. */
    async function saveRow(input: { context: CallContext; connection: ExternalMcpConnection }): Promise<void> {
        const connection = parseConnection({ value: input.connection });
        const rows = await listRows(input);
        if (rows.length >= 100 && !rows.some(row => row.connectionId === connection.connectionId)) throw new RangeError('MCP connection cap');
        await writeRow({ ...input, connection: { ...connection, enabled: false } });
        await required.sessions.close({ context: input.context, connectionId: connection.connectionId });
        if (!connection.enabled) return;
        try {
            await required.sessions.reload({ context: input.context, connection });
            await writeRow({ ...input, connection });
        } catch {
            await required.sessions.close({ context: input.context, connectionId: connection.connectionId });
            throw new Error('MCP enable failed');
        }
    }

    return {
        list: input => boundary({ ...input, operation: 'addons.mcp.list', run: async () => ({ ok: true, value: await listRows(input) }) }),
        save: input => boundary({ ...input, operation: 'addons.mcp.save', run: async () => { await saveRow(input); return { ok: true, value: undefined }; } }),
        provision: input => boundary({ ...input, operation: 'addons.mcp.provision', run: async () => {
            const parsed = parseAgentPluginMcpConfig({ value: boundedJsonSchema.parse(input.configuration), extensionNamespace: 'io.github.ainsep.openmarketing' });
            if (!parsed.ok || parsed.config.serverIds.length !== Object.keys(parsed.config.servers).length) return addonFailure({ code: 'invalid_input' });
            const existing = await listRows(input);
            for (const [name, server] of Object.entries(parsed.config.servers)) {
                const connectionId = 'agent-plugin:' + input.pluginId + ':' + name;
                const previous = existing.find(row => row.connectionId === connectionId);
                if (previous && previous.revision === input.revision) continue;
                await saveRow({ context: input.context, connection: { connectionId, pluginId: input.pluginId, revision: input.revision, enabled: false, server } });
            }
            return { ok: true, value: undefined };
        } }),
        setPluginEnabled: input => boundary({ ...input, operation: 'addons.mcp.set_enabled', run: async () => {
            const rows = (await listRows(input)).filter(row => row.pluginId === input.pluginId);
            try {
                for (const row of rows) await saveRow({ context: input.context, connection: { ...row, enabled: input.enabled } });
            } catch {
                // One failed server must not leave a partially enabled plugin roster.
                await disableRows({ context: input.context, rows });
                throw new Error('MCP plugin activation failed');
            }
            return { ok: true, value: undefined };
        } }),
        removePlugin: input => boundary({ ...input, operation: 'addons.mcp.remove', run: async () => {
            const rows = (await listRows(input)).filter(row => row.pluginId === input.pluginId);
            await disableRows({ context: input.context, rows });
            await required.db.query({ text: 'DELETE FROM addon_external_mcp WHERE owner_id=$1 AND workspace_id=$2 AND plugin_id=$3', values: [input.context.scope.ownerId, input.context.scope.workspaceId, input.pluginId] });
            return { ok: true, value: undefined };
        } }),
        dispose: input => boundary({ ...input, operation: 'addons.mcp.dispose', run: async () => {
            for (const row of await listRows(input)) await required.sessions.close({ context: input.context, connectionId: row.connectionId });
            return { ok: true, value: undefined };
        } }),
    };

    /** Cleanup attempts every row even when one session's disposal fails. Authority closes first. */
    async function disableRows(input: { context: CallContext; rows: ExternalMcpConnection[] }): Promise<void> {
        let failed = false;
        for (const row of input.rows) {
            try { await saveRow({ context: input.context, connection: { ...row, enabled: false } }); }
            catch { failed = true; }
        }
        if (failed) throw new Error('MCP cleanup incomplete');
    }
}

/** Jini validates each transport; unknown declarations are refused rather than silently discarded. */
function parseConnection(required: { value: unknown }): ExternalMcpConnection {
    const shape = z.strictObject({ connectionId: idSchema, pluginId: idSchema.nullable(), revision: idSchema,
        enabled: z.boolean(), credentialConnectionId: idSchema.optional(), server: boundedJsonSchema });
    const value = shape.parse(required.value);
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new RangeError('MCP config cap');
    const parsed = parseAgentPluginMcpConfig({ value: { $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: { connection: value.server } }, extensionNamespace: 'io.github.ainsep.openmarketing' });
    if (!parsed.ok || !parsed.config.servers.connection) throw new Error('Invalid MCP transport');
    return { ...value, server: parsed.config.servers.connection };
}
