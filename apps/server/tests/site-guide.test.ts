/** SG1 fixtures only: written here, execution belongs to Coordinator/T1. */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBoundary } from '@open-marketing/contracts';
import type { CallContext, IdPort, Outcome, ToolResult } from '@open-marketing/contracts';
import { createMemoryConfirmationExchange, createMemorySafetyRepo } from '@open-marketing/safety';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { createAesGcmSecretSealer, createCredentialBroker, createCredentialKeyring, createCredentialService,
    createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryOAuthClient, createSqlCredentialRepo } from '@open-marketing/credentials';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { createIntegrations } from '../src/integrations.js';
import type { AddonToolDependencies } from '../src/addon-tools.js';
import { buildOmToolDefinitions, createOmTools, toolInputSchema } from '../src/om-tools.js';
import type { OmToolDefinition } from '../src/om-tools.js';
import { runOmSiteGuide, siteGuideInputSchema } from '../src/site-guide.js';
import { handleOmRequest } from '../src/inbound/om.js';
import { handleOwnerRequest } from '../src/inbound/owner.js';
import { runOmCli, type CliRuntime } from '../src/cli/index.js';
import { generateOmToolCoverage } from '../src/om-tool-coverage.js';

/** Captured approval evidence; each fixture owns its audit records. */
function answerAudit() {
    const answers: unknown[] = [];
    return { answers, async recordAnswer(input: { answer: unknown }) {
        answers.push(structuredClone(input.answer));
        return { ok: true as const, value: undefined };
    } };
}

const catalog = JSON.parse(readFileSync(new URL('../../../content/agent-plugins/om-playbook/skills/om-playbook/references/om-site-guide.json', import.meta.url), 'utf8'));
const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'a' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
function value<T>({ outcome }: { outcome: Outcome<T> }): T {
    if (!outcome.ok) throw new Error(outcome.error.message);
    return outcome.value;
}
function fixture(required: { addons?: AddonToolDependencies } = {}) {
    let sequence = 0; let active = true; let currentCatalog: unknown = catalog;
    const ids: IdPort = { next: () => 'guide-' + ++sequence }; const clock = { now: () => 1000 }; const observer = { observe() {} };
    const confirmations = createMemoryConfirmationExchange({ ...answerAudit(), clock, ids });
    const services = { confirmations, campaigns: createMemoryCampaignRepo({}), safety: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }) };
    const reads: { name: string; context: CallContext; input: unknown }[] = [];
    const overrides = new Map<string, OmToolDefinition>(); const removed = new Set<string>(); const hiddenForAgent = new Set<string>();
    const authorize = ({ context }: { context: CallContext }): Outcome<void> => active && context.scope.ownerId === 'owner'
        ? { ok: true, value: undefined } : { ok: false, error: { code: 'forbidden', message: 'Authority revoked', retryable: false } };
    const guide: OmToolDefinition = { name: 'site_guide', capability: 'How Open Marketing works', description: 'OM guide', effects: ['read'], policy: 'read', revision: '1',
        inputSchema: toolInputSchema({ schema: siteGuideInputSchema }), parse: input => parseBoundary({ schema: siteGuideInputSchema, input: input.input }),
        invoke: input => runOmSiteGuide({ ...input, catalog: currentCatalog, tools, ids, definitions, authorize }, { signal: input.signal }) };
    async function definitions(input: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> {
        const result = await buildOmToolDefinitions({ ...input, services, siteGuide: guide, addons: required.addons });
        if (!result.ok) return result;
        const definitions = [...result.value.filter(tool => !removed.has(tool.name) && !overrides.has(tool.name)), ...overrides.values()];
        return { ok: true, value: definitions.filter(tool => input.context.principal.kind !== 'agent' || !hiddenForAgent.has(tool.name)) };
    }
    const tools = createOmTools({ definitions, confirmations, clock, observer, authorize });
    const grant = { protocolVersion: 1 as const, grantId: 'grant', scope: owner.scope, runId: 'run', agentInstanceId: 'instance',
        conversationId: 'chat', capabilities: ['tools'], expiresAt: 10000, revoked: false, authenticationEpoch: 1000 };
    const grants = { async verify() { return { ok: true as const, value: grant }; } };
    async function call(input: { operation: 'overview' | 'explain'; topic?: string; context?: CallContext }) {
        const context = input.context ?? agent;
        const args: Record<string, string> = { operation: input.operation };
        if (input.topic !== undefined) args.topic = input.topic;
        return tools.dispatch({ context, call: { name: 'site_guide', input: args, operationId: ids.next({}) } });
    }
    async function rpc(input: { method: string; params?: Record<string, unknown> }) {
        return handleOmRequest({ tools, clock, ids, grants, request: { method: 'POST', path: '/api/agent/v1/mcp', body: { jsonrpc: '2.0', id: 'rpc', ...input } } });
    }
    function read(input: { name: string; output?: unknown; after?: () => void; policy?: 'read' | 'write'; unavailableReason?: string; effects?: OmToolDefinition['effects']; failure?: true }) {
        const schema = z.strictObject({ limit: z.number().int().min(1).max(5).optional() });
        overrides.set(input.name, { name: input.name, capability: 'Fixture', description: 'Fixture', effects: input.effects ?? [input.policy ?? 'read'], policy: input.policy ?? 'read',
            revision: '1', inputSchema: toolInputSchema({ schema }), parse: args => parseBoundary({ schema, input: args.input }), unavailableReason: input.unavailableReason,
            async invoke(args) { reads.push({ name: input.name, context: args.context, input: args.input }); input.after?.();
                return input.failure ? { ok: false, error: { code: 'unavailable', message: 'SECRET adapter error', retryable: false } } : { ok: true, value: input.output }; } });
    }
    return { tools, services: { ...services, tools }, ids, clock, call, rpc, read, reads, removed, hiddenForAgent, definitions, authorize,
        revoke() { active = false; }, catalog(input: unknown) { currentCatalog = input; },
        direct(input: unknown) { return runOmSiteGuide({ context: agent, input, catalog: currentCatalog, tools, ids, definitions, authorize }); } };
}

/** Real credential SQL/list adapter; add-on inventory is empty and all mutation stubs reject.
 * No integration list override: direct agent denial and delegated summary use production code.
 */
function integrationFixture() {
    const native = new Database(':memory:');
    native.exec(readFileSync(new URL('../../../features/credentials/migrations/0001_credentials.sql', import.meta.url), 'utf8'));
    const db: CredentialSqlPort = { async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
        const statement = native.prepare(input.text);
        const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
        if (statement.reader) { const rows = statement.all(parameters) as Row[]; return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: statement.run(parameters).changes };
    } };
    const clock = { now: () => 1000 }; const events: unknown[] = [];
    const observer = { observe(event: unknown) { events.push(event); } };
    const keyring = createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(9) }) });
    let nonce = 0;
    const sealer = createAesGcmSecretSealer({ keyring, configuration: { hkdfSalt: 'fixture-guide-salt', envVarName: 'OM_CREDENTIAL_KEY', keyFilePath: '/fixture/key' },
        randomBytes: ({ size }) => new Uint8Array(size).fill(++nonce) });
    const locks = createMemoryCredentialLock({}); const repo = createSqlCredentialRepo({ db, clock }); const audit = createMemoryCredentialAudit({});
    const service = createCredentialService({ repo, sealer, keyring, locks, audit, clock, oauth: createMemoryOAuthClient({}) });
    const integrations = createIntegrations({ repo, sealer, locks, audit, service, db, observer, broker: createCredentialBroker({ repo, sealer, locks, audit }) });
    const rejected: Outcome<never> = { ok: false, error: { code: 'unavailable', message: 'Fixture mutation unavailable', retryable: false } };
    const addons: AddonToolDependencies = { observer, integrations, addons: {
        async list() { return { ok: true, value: { items: [], cursor: null } }; },
        async describe() { return rejected; }, async install() { return rejected; }, async setEnabled() { return rejected; }, async uninstall() { return rejected; },
    } };
    return { native, integrations, events, addons };
}

describe('OM site guide', () => {
    it('returns twelve concise topics without fact reads or approval cards', async () => {
        const f = fixture();
        try {
            // Fixture definitions expose all twelve catalog topics, without executing these reads.
            for (const name of ['om_media_list', 'om_measure_create_link', 'om_contacts_resolve', 'om_forms_publish', 'integrations_list', 'addons_install']) f.read({ name });
            const result = value({ outcome: await f.call({ operation: 'overview' }) });
            expect(result).toMatchObject({ status: 'completed', output: { version: '1.0.0', operation: 'overview' } });
            const text = JSON.stringify(result);
            for (const topic of catalog.topics) { expect(text).toContain(topic.title); expect(text).not.toContain(topic.explanation); }
            expect(f.reads).toEqual([]);
            expect(value({ outcome: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        } finally { await f.tools.dispose({}); }
    });

    it.each([
        undefined, { ...catalog, unexpected: true }, { ...catalog, topics: [catalog.topics[0], catalog.topics[0]] },
        { ...catalog, topics: [{ ...catalog.topics[0], explanation: 'x'.repeat(6001) }] },
        { ...catalog, topics: Array.from({ length: 13 }, () => catalog.topics[0]) },
        { ...catalog, topics: catalog.topics.map((topic: object) => ({ ...topic, explanation: 'x'.repeat(6000) })) },
        { ...catalog, version: 'x'.repeat(300) },
    ])('fails explicitly for missing or malformed catalogs', async malformed => {
        const f = fixture();
        try { f.catalog(malformed); expect(await f.direct({ operation: 'overview' })).toMatchObject({ ok: false, error: { code: 'unavailable' } }); }
        finally { await f.tools.dispose({}); }
    });

    it.each([{ operation: 'explain', topic: 'unknown' }, { operation: 'overview', workspaceId: 'b' }, { operation: 'explain' }, { operation: 'overview', topic: 'safety' }])('rejects malformed input and supplied identity', async input => {
        const f = fixture();
        try { expect(await f.direct(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } }); expect(f.reads).toEqual([]); }
        finally { await f.tools.dispose({}); }
    });

    it('does not invent a missing catalog topic', async () => {
        const f = fixture();
        try { f.catalog({ ...catalog, topics: [catalog.topics[0]] }); expect(await f.direct({ operation: 'explain', topic: 'media' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } }); }
        finally { await f.tools.dispose({}); }
    });

    it('hides topics from the overview, resource and direct explanation for a caller without their actions', async () => {
        const f = fixture();
        try {
            for (const name of ['om_workspace_current', 'om_workspaces_list', 'om_account_binding_get']) f.hiddenForAgent.add(name);
            const [agentOverview, ownerOverview] = await Promise.all([
                f.call({ operation: 'overview' }), f.call({ operation: 'overview', context: owner }),
            ]);
            expect(JSON.stringify(ownerOverview)).toContain('Workspaces and account scope');
            expect(JSON.stringify(agentOverview)).not.toContain('Workspaces and account scope');
            expect(JSON.stringify(agentOverview)).toContain('Approval policy and halt');
            expect(await f.call({ operation: 'explain', topic: 'workspaces' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
            const resource = await f.rpc({ method: 'resources/read', params: { uri: 'jini://site-guide' } });
            expect(resource.body).toMatchObject({ result: { contents: [{ mimeType: 'application/json' }] } });
            expect(JSON.stringify(resource.body)).not.toContain('Workspaces and account scope');
            expect(await f.call({ operation: 'explain', topic: 'workspaces', context: owner })).toMatchObject({ value: { output: { topic: { id: 'workspaces' } } } });
        } finally { await f.tools.dispose({}); }
    });

    it('omits hidden pointers and fact names from a partly visible topic without reading them', async () => {
        const f = fixture();
        try {
            f.read({ name: 'om_media_list', output: { items: [], cursor: null } });
            f.read({ name: 'om_media_import', policy: 'write' });
            f.hiddenForAgent.add('om_media_list');
            const result = await f.call({ operation: 'explain', topic: 'media' });
            expect(result).toMatchObject({ value: { output: { topic: { id: 'media' }, capabilities: [{ tool: 'om_media_import' }], facts: [] } } });
            for (const name of ['om_media_list', 'om_media_crop', 'om_media_record_provenance']) expect(JSON.stringify(result)).not.toContain(name);
            expect(f.reads).toEqual([]);
            const ownerResult = await f.call({ operation: 'explain', topic: 'media', context: owner });
            expect(ownerResult).toMatchObject({ value: { output: { facts: [{ tool: 'om_media_list', status: 'available', data: [] }] } } });
        } finally { await f.tools.dispose({}); }
    });

    it('fails closed when caller-visible definitions cannot be read or authority changes during discovery', async () => {
        const f = fixture();
        const required = { context: agent, input: { operation: 'overview' }, catalog, tools: f.tools, ids: f.ids, authorize: f.authorize };
        try {
            expect(await runOmSiteGuide({ ...required, definitions: async () => ({ ok: false, error: { code: 'unavailable', message: 'SECRET', retryable: false } }) }))
                .toMatchObject({ ok: false, error: { code: 'unavailable', message: 'Guide capabilities unavailable' } });
            const controller = new AbortController();
            expect(await runOmSiteGuide({ ...required, definitions: async input => { const result = await f.definitions(input); controller.abort(); return result; } }, { signal: controller.signal }))
                .toMatchObject({ ok: false, error: { code: 'cancelled' } });
            expect(await runOmSiteGuide({ ...required, definitions: async input => { const result = await f.definitions(input); f.revoke(); return result; } }))
                .toMatchObject({ ok: false, error: { code: 'forbidden' } });
        } finally { await f.tools.dispose({}); }
    });

    it('uses real SQL-backed integration summaries after authorization while direct agent credential listing stays denied', async () => {
        const integrations = integrationFixture(); const f = fixture({ addons: integrations.addons });
        const otherWorkspace: CallContext = { ...owner, scope: { ...owner.scope, workspaceId: 'b' } };
        try {
            expect(await f.call({ operation: 'explain', topic: 'integrations' }))
                .toMatchObject({ value: { output: { facts: [{ status: 'available', data: [], truncated: false }] } } });
            for (let index = 0; index < 6; index++) value({ outcome: await integrations.integrations.connect({ context: owner,
                request: { connectionId: 'private-connection-' + index, pluginId: 'fixture-plugin', plaintext: 'SECRET-fixture-token-' + index } }) });
            value({ outcome: await integrations.integrations.connect({ context: otherWorkspace,
                request: { connectionId: 'other-workspace', pluginId: 'foreign-plugin', plaintext: 'SECRET-foreign-token' } }) });
            const otherOwner: CallContext = { ...owner, scope: { ...owner.scope, ownerId: 'foreign' }, principal: { kind: 'owner', ownerId: 'foreign' } };
            value({ outcome: await integrations.integrations.connect({ context: otherOwner,
                request: { connectionId: 'other-owner', pluginId: 'foreign-owner-plugin', plaintext: 'SECRET-other-owner' } }) });
            expect(await integrations.integrations.list({ context: agent, query: { limit: 5 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            const result = await f.call({ operation: 'explain', topic: 'integrations' });
            expect(result).toMatchObject({ value: { output: { facts: [{ tool: 'integrations_list', status: 'available',
                data: Array.from({ length: 5 }, () => ({ pluginId: 'fixture-plugin', status: 'saved' })), truncated: true }] } } });
            for (const hidden of ['private-connection', 'SECRET', 'foreign-plugin', 'foreign-owner-plugin']) expect(JSON.stringify(result)).not.toContain(hidden);
            expect(await f.call({ operation: 'explain', topic: 'integrations', context: { ...agent, scope: otherWorkspace.scope } }))
                .toMatchObject({ value: { output: { facts: [{ data: [{ pluginId: 'foreign-plugin', status: 'saved' }], truncated: false }] } } });
            expect(await f.call({ operation: 'explain', topic: 'integrations', context: { ...agent, scope: otherOwner.scope } }))
                .toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(integrations.events).toContainEqual({ operation: 'integrations.list', outcome: 'succeeded', correlationId: agent.correlationId, traceId: agent.traceId, runId: agent.runId });
            const readsBeforeRevocation = integrations.events.length;
            f.revoke();
            expect(await f.call({ operation: 'explain', topic: 'integrations' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(integrations.events).toHaveLength(readsBeforeRevocation);
            expect(value({ outcome: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        } finally { await f.tools.dispose({}); integrations.native.close(); }
    });

    it('isolates concurrent caller scopes, rejects foreign facts, and does not cache reads', async () => {
        const f = fixture();
        try {
            const contexts = [agent, { ...agent, scope: { ...agent.scope, workspaceId: 'b' } }];
            const results = await Promise.all(contexts.map(context => f.call({ operation: 'explain', topic: 'workspaces', context })));
            expect(results[0]).toMatchObject({ value: { output: { facts: [{ status: 'available', data: { workspaceId: 'a' } }] } } });
            expect(results[1]).toMatchObject({ value: { output: { facts: [{ status: 'available', data: { workspaceId: 'b' } }] } } });
            f.read({ name: 'om_workspace_current', output: { ownerId: 'owner', workspaceId: 'other' } });
            expect(await f.call({ operation: 'explain', topic: 'workspaces' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
            expect(f.reads[0].context).toMatchObject({ scope: agent.scope, correlationId: 'correlation', traceId: 'trace', runId: 'run' });
        } finally { await f.tools.dispose({}); }
    });

    it('suppresses all facts if authority is revoked while a read is in progress', async () => {
        const f = fixture();
        try {
            f.read({ name: 'om_workspace_current', output: owner.scope, after: f.revoke });
            expect(await f.direct({ operation: 'explain', topic: 'workspaces' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
            expect(await f.direct({ operation: 'overview' })).toMatchObject({ ok: false });
        } finally { await f.tools.dispose({}); }
    });

    it('distinguishes missing/failed facts from an empty page and hides raw errors and metadata', async () => {
        const f = fixture();
        try {
            f.read({ name: 'om_media_list', unavailableReason: 'Fixture media unavailable' });
            expect(await f.call({ operation: 'explain', topic: 'media' })).toMatchObject({ value: { output: { facts: [{ tool: 'om_media_list', status: 'unavailable' }] } } });
            f.read({ name: 'integrations_list', output: { items: [], cursor: null } });
            expect(await f.call({ operation: 'explain', topic: 'integrations' })).toMatchObject({ value: { output: { facts: [{ status: 'available', data: [], truncated: false }] } } });
            f.read({ name: 'integrations_list', failure: true });
            const failed = await f.call({ operation: 'explain', topic: 'integrations' });
            expect(failed).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
            expect(JSON.stringify(failed)).not.toContain('SECRET');
            f.read({ name: 'integrations_list', output: { items: [], cursor: null, plaintext: 'SECRET' } });
            expect(await f.call({ operation: 'explain', topic: 'integrations' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
        } finally { await f.tools.dispose({}); }
    });

    it('uses fixed bounded pages, projects summaries, and marks partial inventories', async () => {
        const f = fixture();
        try {
            f.read({ name: 'integrations_list', output: { items: [{ connectionId: 'private-connection', pluginId: 'google-ads', status: 'saved' }], cursor: 'more' } });
            const result = await f.call({ operation: 'explain', topic: 'integrations' });
            expect(result).toMatchObject({ value: { output: { facts: [{ data: [{ pluginId: 'google-ads', status: 'saved' }], truncated: true }] } } });
            expect(JSON.stringify(result)).not.toContain('private-connection');
            f.read({ name: 'addons_list', output: { items: Array.from({ length: 6 }, (_, n) => ({ id: 'plugin-' + n, kind: 'plugin', name: 'name', description: 'private-description', version: '1', enabled: true, revision: '1' })), cursor: null } });
            f.read({ name: 'om_chart_providers_list', output: { providers: [] } });
            const addons = await f.call({ operation: 'explain', topic: 'addons' });
            expect(addons).toMatchObject({ value: { output: { facts: [{ status: 'available', truncated: true }, { data: [], truncated: false }] } } });
            expect(JSON.stringify(addons)).not.toContain('plugin-5'); expect(JSON.stringify(addons)).not.toContain('private-description');
            expect(f.reads.map(read => [read.name, read.input])).toEqual([['integrations_list', { limit: 5 }], ['addons_list', { limit: 5 }], ['om_chart_providers_list', {}]]);
            expect(f.reads.length).toBeLessThanOrEqual(3);
        } finally { await f.tools.dispose({}); }
    });

    it('never invokes a write, unadmitted read, recursive guide or unrelated inventory for facts', async () => {
        const f = fixture();
        try {
            f.read({ name: 'om_media_list', policy: 'write', output: { items: [], cursor: null } });
            expect(await f.call({ operation: 'explain', topic: 'media' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
            f.read({ name: 'om_media_list', effects: ['read', 'write'], output: { items: [], cursor: null } });
            expect(await f.call({ operation: 'explain', topic: 'media' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
            f.read({ name: 'om_media_list', effects: [], output: { items: [], cursor: null } });
            expect(await f.call({ operation: 'explain', topic: 'media' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
            f.read({ name: 'om_media_list', unavailableReason: 'SECRET missing binding' });
            const result = await f.call({ operation: 'explain', topic: 'media' });
            expect(result).toMatchObject({ value: { output: { capabilities: [{ tool: 'om_media_list', status: 'unavailable' }] } } });
            expect(JSON.stringify(result)).not.toContain('SECRET');
            f.removed.add('om_contacts_resolve');
            const contacts = await f.call({ operation: 'explain', topic: 'contacts' });
            expect(contacts).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
            expect(f.reads).toEqual([]);
        } finally { await f.tools.dispose({}); }
    });

    it('projects media IDs only and rejects foreign asset scopes', async () => {
        const f = fixture();
        try {
            f.read({ name: 'om_media_list', output: { items: [{ record: { id: 'asset', workspaceId: 'a', title: 'SECRET' }, blob: { storageKey: 'SECRET' } }], cursor: 'more' } });
            const result = await f.call({ operation: 'explain', topic: 'media' });
            expect(result).toMatchObject({ value: { output: { facts: [{ data: [{ assetId: 'asset' }], truncated: true }] } } });
            expect(JSON.stringify(result)).not.toContain('SECRET');
            f.read({ name: 'om_media_list', output: { items: [{ record: { id: 'asset', workspaceId: 'b' } }], cursor: null } });
            expect(await f.call({ operation: 'explain', topic: 'media' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
        } finally { await f.tools.dispose({}); }
    });

    it('returns validated allowance settings and keeps output under the tool envelope', async () => {
        const f = fixture();
        try {
            const result = await f.call({ operation: 'explain', topic: 'creative' });
            expect(result).toMatchObject({ value: { output: { facts: [{ tool: 'om_allowance_get', status: 'available', data: { amount: { minorUnits: 1000, currency: 'USD' } } }] } } });
            expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64512);
            const aborted = new AbortController(); aborted.abort();
            expect(await runOmSiteGuide({ context: agent, input: { operation: 'overview' }, catalog, tools: f.tools, ids: f.ids, definitions: f.definitions, authorize: f.authorize }, { signal: aborted.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
        } finally { await f.tools.dispose({}); }
    });

    it('projects only chart identities/kinds and rejects malformed charts or allowance', async () => {
        const f = fixture();
        try {
            f.read({ name: 'addons_list', unavailableReason: 'Fixture add-ons unavailable' });
            const javascript = '/api/addons/v1/chart-assets/' + 'a'.repeat(64) + '/provider.js';
            f.read({ name: 'om_chart_providers_list', output: { providers: Array.from({ length: 6 }, (_, n) => ({ id: 'chart-' + n, pluginId: 'charts', version: '1', digest: 'a'.repeat(64), contractVersion: 1, kinds: ['bar'], javascript })) } });
            const result = await f.call({ operation: 'explain', topic: 'addons' });
            expect(result).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }, { status: 'available', truncated: true }] } } });
            expect(JSON.stringify(result)).not.toContain(javascript); expect(JSON.stringify(result)).not.toContain('chart-5');
            f.read({ name: 'om_chart_providers_list', output: { providers: [{ id: 'malformed' }] } });
            expect(await f.call({ operation: 'explain', topic: 'addons' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }, { status: 'unavailable' }] } } });
            f.read({ name: 'om_allowance_get', output: { amount: { minorUnits: -1, currency: 'USD' }, dayTimezone: 'UTC', revision: 0 } });
            expect(await f.call({ operation: 'explain', topic: 'settings' })).toMatchObject({ value: { output: { facts: [{ status: 'unavailable' }] } } });
        } finally { await f.tools.dispose({}); }
    });

    it('advertises the resource and returns the same fresh overview as the catalog tool', async () => {
        const f = fixture();
        try {
            const initialized = await f.rpc({ method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
            expect(initialized.body).toMatchObject({ result: { capabilities: { resources: {}, tools: {} } } });
            expect((await f.rpc({ method: 'resources/list', params: {} })).body).toMatchObject({ result: { resources: [{ uri: 'jini://site-guide', mimeType: 'application/json' }] } });
            expect((await f.rpc({ method: 'resources/list' })).body).toMatchObject({ result: { resources: [{ uri: 'jini://site-guide', mimeType: 'application/json' }] } });
            const direct = value({ outcome: await f.call({ operation: 'overview' }) });
            const response = await f.rpc({ method: 'resources/read', params: { uri: 'jini://site-guide' } });
            const contents = (response.body as { result: { contents: { text: string }[] } }).result.contents;
            expect(JSON.parse(contents[0].text)).toEqual((direct as Extract<ToolResult, { status: 'completed' }>).output);
            f.catalog({ ...catalog, version: '1.0.1' });
            const fresh = await f.rpc({ method: 'resources/read', params: { uri: 'jini://site-guide' } });
            expect(JSON.stringify(fresh.body)).toContain('1.0.1');
            expect((await f.rpc({ method: 'resources/read', params: { uri: 'file:///secret' } })).body).toMatchObject({ error: { code: -32602 } });
            f.revoke();
            expect((await f.rpc({ method: 'resources/read', params: { uri: 'jini://site-guide' } })).body).toMatchObject({ error: { code: -32603 } });
        } finally { await f.tools.dispose({}); }
    });

    it('discovers and reads the built-in guide over existing owner HTTP and CLI without a card', async () => {
        const f = fixture(); const stdout: string[] = [];
        const runtime: CliRuntime = { env: { OM_SERVER_URL: 'http://fixture.test', OM_OWNER_TOKEN: 'fixture' }, clock: f.clock, ids: f.ids,
            deadline: { create() { return { signal: new AbortController().signal, dispose() {} }; } },
            stdout: { write({ text }) { stdout.push(text); } }, stderr: { write() {} }, async confirm() { throw new Error('Guide must not ask for approval'); },
            async *readPrompt() { yield new TextEncoder().encode('{"operation":"overview"}'); },
            fetch: (async (url: URL, init?: RequestInit) => {
                const response = await handleOwnerRequest({ context: owner, services: f.services, request: { method: init?.method === 'POST' ? 'POST' : 'GET',
                    path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined } });
                return new Response(JSON.stringify(response.body), { status: response.status });
            }) as typeof fetch };
        try {
            for (const argv of [['tools', 'list', '--json'], ['tools', 'show', 'site_guide', '--json'], ['tools', 'call', 'site_guide', '--input-file', '-', '--json']]) {
                expect((await runOmCli({ argv, runtime })).ok).toBe(true);
            }
            expect(stdout[0]).toContain('site_guide'); expect(stdout[1]).toContain('"effects":["read"]'); expect(stdout[2]).toContain('"operation":"overview"');
            const definitions = value({ outcome: await f.definitions({ context: owner }) });
            expect(generateOmToolCoverage({ definitions }).find(row => row.tool === 'site_guide')).toMatchObject({ status: 'connected', policy: 'read' });
            expect(generateOmToolCoverage({ definitions }).find(row => row.mcp === 'jini://site-guide')).toMatchObject({ status: 'connected' });
            expect(value({ outcome: await f.services.confirmations.list({ context: owner, query: { limit: 100 } }) }).items).toEqual([]);
        } finally { await f.tools.dispose({}); }
    });
});
