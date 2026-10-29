/** Workspace mail selection and connection summaries; never loads modules or credentials. */
import { z } from 'zod';
import { MAIL_PROVIDER_SETTING_KEY } from '@jini-ai/platform/mail';
import { idSchema, mailManifestExtensionSchema, mailProviderSelectionSchema, mailProviderSettingsSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, Outcome, UnitOfWork, MailProviderSelection, MailProviderSettings } from '@open-marketing/contracts';
import { listCredentialConnections } from '@open-marketing/credentials';
import type { Addons } from '../addons.js';
import { readAddonCatalog } from '../addon-tools.js';
import type { AgentPluginState } from '../composition/agent-plugin-backends.js';
import { alertFailure } from './rules.js';

const alertSenderSchema = z.strictObject({ pluginId: idSchema, connectionId: idSchema, alertFrom: z.unknown() });
const alertFromSettingKey = 'mail.alertFrom';
const upsertSettingSql = `INSERT INTO om_owner_settings(owner_id,workspace_id,key,value_json) VALUES ($1,$2,$3,$4)
    ON CONFLICT(owner_id,workspace_id,key) DO UPDATE SET value_json=excluded.value_json`;
export type AlertSender = z.infer<typeof alertSenderSchema>;
/** Existing installed-state and catalog readers, injected by the host. */
export type ProviderReaders = {
    unit: UnitOfWork; addons: Pick<Addons, 'list'>;
    agentPluginState(input: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
};
type SenderReaders = Pick<ProviderReaders, 'unit' | 'agentPluginState'> & { context: CallContext };

function isScopedOwner(required: { context: CallContext }): boolean {
    return required.context.principal.kind === 'owner' && required.context.principal.ownerId === required.context.scope.ownerId;
}

/** A declaration is discovery metadata, never authority to load or send. O(descriptors), <=16. */
function mailCandidate(required: { state: AgentPluginState | null }): required is { state: AgentPluginState } {
    const state = required.state;
    if (!state?.enabled || !state.admitted) return false;
    const metadata = mailManifestExtensionSchema.safeParse(state.metadata);
    return metadata.success && (metadata.data.mailAdapters?.length ?? 0) > 0;
}

/** Decode a bounded settings value; absent or invalid JSON/schema values read as null. */
function parseStored<T>(required: { raw: unknown; schema: z.ZodType<T> }): T | null {
    try {
        const parsed = required.schema.safeParse(JSON.parse(String(required.raw)));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

/** Two scoped indexed reads in one transaction; invalid values use the unselected/default state. */
async function readSelection(required: { context: CallContext; unit: UnitOfWork }): Promise<MailProviderSelection> {
    return required.unit.transaction({ work: async ({ session }) => {
        const result = await session.query({ text: 'SELECT value_json FROM om_owner_settings WHERE owner_id=$1 AND workspace_id=$2 AND key=$3',
            values: [required.context.scope.ownerId, required.context.scope.workspaceId, MAIL_PROVIDER_SETTING_KEY] });
        const from = await session.query({ text: 'SELECT value_json FROM om_owner_settings WHERE owner_id=$1 AND workspace_id=$2 AND key=$3',
            values: [required.context.scope.ownerId, required.context.scope.workspaceId, alertFromSettingKey] });
        return { selected: parseStored({ raw: result.rows[0]?.value_json, schema: idSchema.nullable() }),
            alertFrom: parseStored({ raw: from.rows[0]?.value_json, schema: mailProviderSelectionSchema.shape.alertFrom.unwrap() }) };
    } });
}

/** One bounded connection-summary query; multiple connections are deliberately unbound. */
async function singleConnection(required: { context: CallContext; unit: UnitOfWork; pluginId: string }): Promise<Outcome<string | null>> {
    return required.unit.transaction({ work: async ({ session }) => {
        const result = await listCredentialConnections({ context: required.context, db: session,
            query: { pluginId: required.pluginId, status: 'connected', limit: 2 } });
        if (!result.ok) return result;
        return { ok: true, value: result.value.items.length === 1 ? result.value.items[0]!.connectionId : null };
    } });
}

/** Preserve stale selections for display while listing only current enabled/admitted candidates.
 * Requires the scoped owner before any reader; returns fixed failures and reads no secrets or provider modules.
 * @example await getMailProviderSettings({ context, unit, addons, agentPluginState });
 * @complexity Existing catalog paging <=1000 rows; one state read and one bounded SQL read per candidate.
 */
export async function getMailProviderSettings(required: ProviderReaders & { context: CallContext }): Promise<Outcome<MailProviderSettings>> {
    if (!isScopedOwner(required)) return alertFailure({ code: 'forbidden', message: 'Mail provider settings require the scoped owner' });
    try {
        const catalog = await readAddonCatalog({ ...required, kind: 'agent-plugin' });
        if (!catalog.ok) return catalog;
        const { selected, alertFrom } = await readSelection(required);
        const candidates: MailProviderSettings['candidates'] = [];
        for (const addon of catalog.value.filter(row => row.kind === 'agent-plugin').filter(row => row.enabled)) {
            const current = { state: await required.agentPluginState({ context: required.context, pluginId: addon.id }) };
            if (!mailCandidate(current)) continue;
            const connection = await singleConnection({ ...required, pluginId: addon.id });
            if (!connection.ok) return connection;
            candidates.push({ pluginId: addon.id, label: addon.name, status: connection.value === null ? 'not_connected' : 'connected' });
        }
        return parseBoundary({ schema: mailProviderSettingsSchema, input: { selected, alertFrom, candidates } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Mail provider settings unavailable' }); }
}

/** Store a current candidate and an optional owner/workspace From override in one transaction.
 * Null clears the override; omission preserves it across provider changes. Fixed failures never echo input.
 * @example await putMailProviderSettings({ context, selected: null, unit, addons, agentPluginState });
 * @complexity One bounded catalog read followed by at most two scoped upserts; clearing skips the catalog.
 */
export async function putMailProviderSettings(required: ProviderReaders & { context: CallContext } & MailProviderSelection): Promise<Outcome<MailProviderSelection>> {
    if (!isScopedOwner(required)) return alertFailure({ code: 'forbidden', message: 'Mail provider settings require the scoped owner' });
    const parsed = parseBoundary({ schema: mailProviderSelectionSchema, input: { selected: required.selected, alertFrom: required.alertFrom } });
    if (!parsed.ok) return parsed;
    try {
        if (parsed.value.selected !== null) {
            const current = await getMailProviderSettings(required);
            if (!current.ok) return current;
            if (!current.value.candidates.some(candidate => candidate.pluginId === parsed.value.selected))
                return alertFailure({ code: 'invalid_input', message: 'Mail provider is not a current candidate' });
        }
        await required.unit.transaction({ work: async ({ session }) => {
            await session.query({ text: upsertSettingSql,
                values: [required.context.scope.ownerId, required.context.scope.workspaceId, MAIL_PROVIDER_SETTING_KEY, JSON.stringify(parsed.value.selected)] });
            if (parsed.value.alertFrom !== undefined) await session.query({ text: upsertSettingSql,
                values: [required.context.scope.ownerId, required.context.scope.workspaceId, alertFromSettingKey, JSON.stringify(parsed.value.alertFrom)] });
        } });
        return { ok: true, value: parsed.value };
    } catch { return alertFailure({ code: 'unavailable', message: 'Mail provider settings unavailable' }); }
}

/** Resolve once per evaluation/dispatch. Missing, disabled or ambiguous bindings return null.
 * alertFrom stays tainted until the email boundary validates both addresses before notice I/O.
 * @example await resolveAlertSender({ context, unit, agentPluginState });
 * @complexity Two setting reads, one state read, one bounded connection query; no module/secret reads.
 */
export async function resolveAlertSender(required: SenderReaders): Promise<Outcome<AlertSender | null>> {
    try {
        const { selected: pluginId, alertFrom } = await readSelection(required);
        if (pluginId === null) return { ok: true, value: null };
        const current = { state: await required.agentPluginState({ context: required.context, pluginId }) };
        if (!mailCandidate(current)) return { ok: true, value: null };
        const connection = await singleConnection({ ...required, pluginId });
        if (!connection.ok) return connection;
        return { ok: true, value: connection.value === null ? null : { pluginId, connectionId: connection.value, alertFrom: alertFrom ?? current.state.metadata.alertFrom } };
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert sender unavailable' }); }
}
