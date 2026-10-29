/** Written-only owner boundary and real scoped settings/connection SQL regressions. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { AddonSummary, CallContext, UnitOfWork } from '@open-marketing/contracts';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createMemorySafetyRepo } from '@open-marketing/safety';
import { bindServerDatabase } from '../src/composition/database.js';
import { handleProviderSettingsRequest } from '../src/inbound/provider-settings.js';
import { getMailProviderSettings, putMailProviderSettings, resolveAlertSender, type ProviderReaders } from '../src/alerts/index.js';
import { buildOmToolDefinitions, createOmTools } from '../src/om-tools.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' },
    correlationId: 'settings-correlation', traceId: 'settings-trace' };
const descriptor = { id: 'fixture-adapter', label: 'Adapter label is not the plugin name', module: 'mail/index.mjs', credentialKeys: ['token'], feedback: false };
type State = NonNullable<Awaited<ReturnType<ProviderReaders['agentPluginState']>>>;

/** Uses production migrations/readers; the only doubles are the installed catalog and state. */
function fixture(_input: Record<string, never>) {
    const native = new Database(':memory:');
    native.exec(readFileSync(new URL('../migrations/0006_alerts.sql', import.meta.url), 'utf8'));
    native.exec(readFileSync(new URL('../../../features/credentials/migrations/0001_credentials.sql', import.meta.url), 'utf8'));
    const observer = { observe() {} };
    const { unit } = bindServerDatabase({ native, context, observer });
    const catalog: AddonSummary[] = [];
    const states = new Map<string, State>();
    const addons: ProviderReaders['addons'] = { list: vi.fn(async () => ({ ok: true as const, value: { items: catalog, cursor: null } })) };
    const agentPluginState = vi.fn(async ({ pluginId }: { context: CallContext; pluginId: string }) => states.get(pluginId) ?? null);
    return { unit, native, addons, agentPluginState, context,
        add(required: { pluginId: string; enabled?: boolean; admitted?: boolean; metadata?: Record<string, unknown> }) {
            catalog.push({ id: required.pluginId, kind: 'agent-plugin', name: 'Plugin ' + required.pluginId, description: '',
                version: '1.0.0', revision: 'revision', enabled: required.enabled ?? true });
            states.set(required.pluginId, { enabled: required.enabled ?? true, admitted: required.admitted ?? true, bundled: false,
                revision: 'revision', metadata: required.metadata ?? { mailAdapters: [descriptor], alertFrom: 'alerts@example.test' } });
        },
        connect(required: { pluginId: string; connectionId: string; context?: CallContext; status?: string }) {
            const scope = (required.context ?? context).scope;
            native.prepare(`INSERT INTO om_credential_connection(owner_id,workspace_id,connection_id,plugin_id,status,version,ciphertext,aad_digest)
                VALUES (?,?,?,?,?,1,'sealed-fixture','digest')`).run(scope.ownerId, scope.workspaceId, required.connectionId, required.pluginId, required.status ?? 'connected');
        },
        close() { native.close(); },
    };
}

it.each(['agent', 'other-owner'] as const)('denies %s before body, catalog, state or SQL readers', async principal => {
    const transaction = vi.fn(async () => { throw new Error('Unexpected SQL'); });
    const unit: UnitOfWork = { transaction };
    const list = vi.fn(async () => { throw new Error('Unexpected catalog'); });
    const agentPluginState = vi.fn(async () => { throw new Error('Unexpected state'); });
    const readBody = vi.fn(async () => { throw new Error('Unexpected body'); });
    const foreign: CallContext = { ...context, principal: principal === 'agent' ? { kind: 'agent', agentInstanceId: 'agent', runId: 'run' }
        : { kind: 'owner', ownerId: 'other-owner' } };
    for (const method of ['GET', 'POST'] as const) {
        expect(await handleProviderSettingsRequest({ context: foreign, unit, addons: { list }, agentPluginState,
            request: { method, path: '/api/addons/v1/provider-settings/mail', readBody } })).toMatchObject({ status: 403, body: { ok: false, error: { code: 'forbidden' } } });
    }
    for (const spy of [transaction, list, agentPluginState, readBody]) expect(spy).not.toHaveBeenCalled();
});

it.each<CallContext['principal']>([
    { kind: 'agent', agentInstanceId: 'agent', runId: 'run' },
    { kind: 'service', serviceId: 'fixture-service' },
    { kind: 'owner', ownerId: 'other-owner' },
])('refuses direct settings calls for $kind before any reader, including clearing', async principal => {
    const transaction = vi.fn(async () => { throw new Error('Unexpected SQL'); });
    const unit: UnitOfWork = { transaction };
    const list = vi.fn(async () => { throw new Error('Unexpected catalog'); });
    const agentPluginState = vi.fn(async () => { throw new Error('Unexpected state'); });
    const required = { context: { ...context, principal }, unit, addons: { list }, agentPluginState };
    expect(await getMailProviderSettings(required)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    for (const selected of ['example-mail', null]) {
        expect(await putMailProviderSettings({ ...required, selected, alertFrom: 'owner@example.test' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    for (const spy of [transaction, list, agentPluginState]) expect(spy).not.toHaveBeenCalled();
});

it('GET lists only current declared candidates and exactly-one-connection readiness', async () => {
    const f = fixture({});
    try {
        for (const pluginId of ['connected-mail', 'unconnected-mail', 'multiple-mail']) f.add({ pluginId });
        f.add({ pluginId: 'disabled-mail', enabled: false });
        f.add({ pluginId: 'unadmitted-mail', admitted: false });
        f.add({ pluginId: 'plain-plugin', metadata: {} });
        f.add({ pluginId: 'empty-mail', metadata: { mailAdapters: [] } });
        f.add({ pluginId: 'invalid-mail', metadata: { mailAdapters: [{ module: '../escape.mjs' }] } });
        f.connect({ pluginId: 'connected-mail', connectionId: 'one' });
        f.connect({ pluginId: 'connected-mail', connectionId: 'old', status: 'revoked' });
        f.connect({ pluginId: 'multiple-mail', connectionId: 'two-a' });
        f.connect({ pluginId: 'multiple-mail', connectionId: 'two-b' });
        f.connect({ pluginId: 'unconnected-mail', connectionId: 'expired', status: 'reconnect_required' });
        const response = await handleProviderSettingsRequest({ ...f, request: { method: 'GET', path: '/api/addons/v1/provider-settings/mail' } });
        expect(response).toMatchObject({ status: 200, body: { ok: true, value: { selected: null, candidates: [
            { pluginId: 'connected-mail', label: 'Plugin connected-mail', status: 'connected' },
            { pluginId: 'unconnected-mail', label: 'Plugin unconnected-mail', status: 'not_connected' },
            { pluginId: 'multiple-mail', label: 'Plugin multiple-mail', status: 'not_connected' },
        ] } } });
        expect(f.addons.list).toHaveBeenCalledWith({ context, query: { kind: 'agent-plugin', limit: 100, cursor: undefined } }, undefined);
        expect(await resolveAlertSender(f)).toEqual({ ok: true, value: null });
    } finally { f.close(); }
});

it('reads real settings through tools and changes selection only after a fresh owner card, including clear', async () => {
    const f = fixture({});
    let sequence = 0;
    const clock = { now: () => 1000 }; const ids = { next: () => 'mail-card-' + ++sequence };
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer() { return { ok: true, value: undefined }; } });
    const agent: CallContext = { ...context, runId: 'run', principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' } };
    const services = { confirmations, safety: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), campaigns: createMemoryCampaignRepo({}) };
    const tools = createOmTools({ clock, observer: { observe() {} }, confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: input => buildOmToolDefinitions({ ...input, services, providerSettings: f }) });
    try {
        f.add({ pluginId: 'previous-mail' }); f.add({ pluginId: 'example-mail' });
        f.connect({ pluginId: 'example-mail', connectionId: 'connected' });
        expect(await putMailProviderSettings({ ...f, selected: 'previous-mail' })).toEqual({ ok: true, value: { selected: 'previous-mail' } });
        expect(await tools.dispatch({ context: agent, call: { name: 'om_mail_provider_get', input: {}, operationId: 'read-mail' } }))
            .toEqual({ ok: true, value: { status: 'completed', output: { selected: 'previous-mail', alertFrom: null, candidates: [
                { pluginId: 'previous-mail', label: 'Plugin previous-mail', status: 'not_connected' },
                { pluginId: 'example-mail', label: 'Plugin example-mail', status: 'connected' },
            ] } } });
        expect(f.agentPluginState).toHaveBeenCalledWith({ context: { ...agent, principal: context.principal }, pluginId: 'example-mail' });
        for (const selected of ['example-mail', null]) {
            const operationId = selected === null ? 'clear-mail' : 'select-mail';
            const alertFrom = selected === null ? null : 'tool-from@example.test';
            const before = f.native.prepare('SELECT key,value_json FROM om_owner_settings').all();
            expect(await tools.dispatch({ context: agent, call: { name: 'om_mail_provider_set', input: { selected, alertFrom }, operationId } }))
                .toMatchObject({ ok: true, value: { status: 'pending', operationId, cardId: expect.any(String) } });
            expect(f.native.prepare('SELECT key,value_json FROM om_owner_settings').all()).toEqual(before);
            const card = await tools.card({ context, operationId });
            if (!card.ok || !card.value) throw new Error('Expected mail provider card');
            expect(card.value.allowedChoices).toEqual(['allow', 'cancel']);
            expect(await tools.answer({ context, approver: { kind: 'local_token', ownerId: 'owner', deviceId: 'fixture-device', tokenId: 'fixture-token' },
                response: { cardId: card.value.cardId, operationId, argumentsDigest: card.value.argumentsDigest, choice: 'allow' } }))
                .toEqual({ ok: true, value: undefined });
            expect(await tools.operation({ context: agent, operationId })).toEqual({ ok: true, value: { status: 'completed', operationId, output: { selected, alertFrom } } });
            expect(f.native.prepare('SELECT key,value_json FROM om_owner_settings').all()).toEqual([{ key: 'mail.provider', value_json: JSON.stringify(selected) }, { key: 'mail.alertFrom', value_json: JSON.stringify(alertFrom) }]);
            expect(await tools.dispatch({ context: agent, call: { name: 'om_mail_provider_get', input: {}, operationId: 'read-' + operationId } }))
                .toMatchObject({ ok: true, value: { status: 'completed', output: { selected, alertFrom } } });
        }
    } finally { await tools.dispose({}); f.close(); }
});

it('POST refuses non-candidates, allows an unconnected selection and clears stale selections', async () => {
    const f = fixture({});
    const request = { method: 'POST' as const, path: '/api/addons/v1/provider-settings/mail' };
    try {
        f.add({ pluginId: 'example-mail' });
        f.add({ pluginId: 'disabled-mail', enabled: false });
        for (const selected of ['missing-mail', 'disabled-mail']) {
            expect(await handleProviderSettingsRequest({ ...f, request: { ...request, body: { selected } } }))
                .toMatchObject({ status: 400, body: { ok: false, error: { code: 'invalid_input' } } });
        }
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM om_owner_settings').get()).toEqual({ count: 0 });
        expect(await handleProviderSettingsRequest({ ...f, request: { ...request, body: { selected: 'example-mail', alertFrom: 'owner-from@example.test' } } }))
            .toMatchObject({ status: 200, body: { ok: true, value: { selected: 'example-mail', alertFrom: 'owner-from@example.test' } } });
        expect(f.native.prepare("SELECT value_json FROM om_owner_settings WHERE key='mail.alertFrom'").get()).toEqual({ value_json: JSON.stringify('owner-from@example.test') });
        expect(await getMailProviderSettings(f)).toMatchObject({ ok: true, value: { alertFrom: 'owner-from@example.test' } });
        expect(await resolveAlertSender(f)).toEqual({ ok: true, value: null });
        f.connect({ pluginId: 'example-mail', connectionId: 'bound' });
        expect(await resolveAlertSender(f)).toEqual({ ok: true, value: { pluginId: 'example-mail', connectionId: 'bound', alertFrom: 'owner-from@example.test' } });
        f.add({ pluginId: 'other-mail' });
        expect(await putMailProviderSettings({ ...f, selected: 'other-mail' })).toEqual({ ok: true, value: { selected: 'other-mail' } });
        expect(await getMailProviderSettings(f)).toMatchObject({ ok: true, value: { selected: 'other-mail', alertFrom: 'owner-from@example.test' } });
        expect(await handleProviderSettingsRequest({ ...f, request: { ...request, body: { selected: 'example-mail', alertFrom: null } } }))
            .toMatchObject({ status: 200, body: { ok: true, value: { selected: 'example-mail', alertFrom: null } } });
        expect(f.native.prepare("SELECT value_json FROM om_owner_settings WHERE key='mail.alertFrom'").get()).toEqual({ value_json: 'null' });
        expect(await getMailProviderSettings(f)).toMatchObject({ ok: true, value: { alertFrom: null } });
        expect(await resolveAlertSender(f)).toMatchObject({ ok: true, value: { alertFrom: 'alerts@example.test' } });
        f.native.prepare("UPDATE om_owner_settings SET value_json=? WHERE key='mail.alertFrom'").run(JSON.stringify('invalid-stored-address'));
        expect(await resolveAlertSender(f)).toMatchObject({ ok: true, value: { alertFrom: 'alerts@example.test' } });
        await putMailProviderSettings({ ...f, selected: 'example-mail', alertFrom: null });
        f.addons.list = vi.fn(async () => ({ ok: true as const, value: { items: [], cursor: null } }));
        expect(await getMailProviderSettings(f)).toEqual({ ok: true, value: { selected: 'example-mail', alertFrom: null, candidates: [] } });
        expect(await handleProviderSettingsRequest({ ...f, request: { ...request, body: { selected: null } } }))
            .toMatchObject({ status: 200, body: { ok: true, value: { selected: null } } });
        expect(f.native.prepare('SELECT key,value_json FROM om_owner_settings').all()).toEqual([{ key: 'mail.provider', value_json: 'null' }, { key: 'mail.alertFrom', value_json: 'null' }]);
    } finally { f.close(); }
});

it('isolates selections and connections by workspace and owner; invalid stored selection is null', async () => {
    const f = fixture({});
    const otherWorkspace = { ...context, scope: { ...context.scope, workspaceId: 'elsewhere' } };
    const otherOwner: CallContext = { ...context, scope: { ownerId: 'another-owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'another-owner' } };
    try {
        f.add({ pluginId: 'example-mail' });
        f.connect({ pluginId: 'example-mail', connectionId: 'foreign', context: otherWorkspace });
        expect(await putMailProviderSettings({ ...f, selected: 'example-mail', alertFrom: 'scoped@example.test' })).toEqual({ ok: true, value: { selected: 'example-mail', alertFrom: 'scoped@example.test' } });
        expect(await resolveAlertSender(f)).toEqual({ ok: true, value: null });
        for (const scoped of [otherWorkspace, otherOwner]) {
            expect(await getMailProviderSettings({ ...f, context: scoped })).toMatchObject({ ok: true, value: { selected: null, alertFrom: null } });
            expect(await putMailProviderSettings({ ...f, context: scoped, selected: null, alertFrom: 'foreign@example.test' })).toEqual({ ok: true, value: { selected: null, alertFrom: 'foreign@example.test' } });
        }
        expect(await getMailProviderSettings(f)).toMatchObject({ ok: true, value: { selected: 'example-mail', alertFrom: 'scoped@example.test' } });
        f.native.prepare('UPDATE om_owner_settings SET value_json=? WHERE owner_id=? AND workspace_id=?').run('{"invalid":true}', 'owner', 'workspace');
        expect(await getMailProviderSettings(f)).toMatchObject({ ok: true, value: { selected: null } });
        expect(() => f.native.prepare('UPDATE om_owner_settings SET value_json=?').run('not-json')).toThrow();
        expect(() => f.native.prepare('UPDATE om_owner_settings SET value_json=?').run(JSON.stringify('x'.repeat(4096)))).toThrow();
    } finally { f.close(); }
});

it('rejects malformed bodies and unknown routes without reflecting reader errors', async () => {
    const f = fixture({});
    try {
        for (const body of [{}, { selected: '' }, { selected: 4 }, { selected: null, ownerId: 'forged' }]) {
            expect(await handleProviderSettingsRequest({ ...f, request: { method: 'POST', path: '/api/addons/v1/provider-settings/mail', body } })).toMatchObject({ status: 400 });
        }
        const invalidAddress = 'synthetic-secret-invalid-address';
        const invalid = await handleProviderSettingsRequest({ ...f, request: { method: 'POST', path: '/api/addons/v1/provider-settings/mail', body: { selected: null, alertFrom: invalidAddress } } });
        expect(invalid.status).toBe(400);
        expect(JSON.stringify(invalid)).not.toContain(invalidAddress);
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM om_owner_settings').get()).toEqual({ count: 0 });
        expect(f.addons.list).not.toHaveBeenCalled();
        expect(await putMailProviderSettings({ ...f, selected: null, alertFrom: invalidAddress })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(f.native.prepare('SELECT COUNT(*) AS count FROM om_owner_settings').get()).toEqual({ count: 0 });
        const response = await handleProviderSettingsRequest({ ...f, request: { method: 'POST', path: '/api/addons/v1/provider-settings/mail',
            readBody: async () => { throw new Error('synthetic-secret'); } } });
        expect(response.status).toBe(400);
        expect(JSON.stringify(response)).not.toContain('synthetic-secret');
        expect(await handleProviderSettingsRequest({ ...f, request: { method: 'GET', path: '/api/addons/v1/provider-settings/unknown' } })).toMatchObject({ status: 404 });
    } finally { f.close(); }
});
