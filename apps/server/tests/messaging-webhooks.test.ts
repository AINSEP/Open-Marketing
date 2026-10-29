/** Written-only host regressions: real policy/contacts SQLite, injected plugin loader and one listener. */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { CallContext, ObserverEvent, Outcome } from '@open-marketing/contracts';
import { createSqlContactRepo } from '@open-marketing/contacts';
import { createMemoryAccountDispatchLock, createMemorySafetyRepo } from '@open-marketing/safety';
import { ingestWebhook as realWebhook } from '../../../content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/index.js';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import type { AgentPluginState } from '../src/composition/agent-plugin-backends.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { bindIdentity, createVisitTokens } from '../src/composition/identity.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';
import { createNodeHttpListener } from '../src/inbound/http.js';
import { handleMessagingWebhook } from '../src/inbound/messaging-webhooks.js';
import type { HttpRequest } from '../src/ports.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    principal: { kind: 'service', serviceId: 'public-ingress' }, correlationId: 'correlation', traceId: 'trace', runId: 'webhook-run' };
const pluginId = 'fixture-messaging', connectionId = 'connection', accountId = 'AC' + 'a'.repeat(32);
const path = '/hooks/agent-plugins/' + pluginId + '/' + connectionId + '/' + accountId;
const webhookUrl = 'https://example.test' + path;
const card = { accountSid: accountId, apiKeySid: 'SK' + 'b'.repeat(32), apiKeySecret: 'fixture-key-secret', authToken: 'fixture-auth-token', webhookUrl };
const phone = '+15555550100';

/** Setup failures throw so assertions can never silently skip a broken fixture. */
function value<T>(required: { result: Outcome<T> }): T {
    expect(required.result.ok).toBe(true);
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}

/** Real contacts/policy and existing subject lane, with call-scoped credential and module doubles. */
async function fixture(_required: Record<string, never>) {
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    const events: ObserverEvent[] = [];
    const observer = { observe(event: ObserverEvent) { events.push(event); } };
    let instant = 1000, sequence = 0;
    const clock = { now: () => instant }, ids = { next: () => 'webhook-fixture-' + ++sequence };
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const subjectLane = createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get });
    const identityInput = { unit: database.unit, clock, ids, observer, digestKey: new Uint8Array([1, 2, 3]), subjectLane,
        tokens: createVisitTokens({ key: new Uint8Array([1, 2, 3]), clock, ids }).tokens };
    const identity = bindIdentity(identityInput);
    const states = new Map<string, AgentPluginState>([[pluginId, { enabled: true, admitted: true, bundled: false,
        revision: 'a'.repeat(64), entryUrl: 'file:///installed/fixture-messaging/index.mjs', metadata: {} }]]);
    const loadModule = vi.fn(async (_input: { moduleUrl: string }): Promise<object> => ({ ingestWebhook: realWebhook }));
    const access = vi.fn(async () => ({ ok: true as const, value: { accessToken: JSON.stringify(card) } }));
    let bindingConnection = connectionId;
    const ports: Parameters<typeof bindAgentPluginBackends>[0] = { projectRoot: '/fixtures', clock, observer, mode: 'read_only',
        addons: { async list() { return { ok: true, value: { items: [], cursor: null } }; } },
        state: async ({ pluginId: id }) => states.get(id) ?? null, moduleDigest: async () => 'b'.repeat(64), loadModule,
        integrations: { access }, accounts: { async find({ externalAccountId }) { return { ok: true, value: {
            id: 'binding', scope: context.scope, connectionId: bindingConnection, externalAccountId } }; } },
        safetyRepo: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), accountLocks: createMemoryAccountDispatchLock({ ids }),
        jobs: bindAgentPluginJobs({ unit: database.unit, clock, ids, observer }), subjectLane,
        fetch: vi.fn(async () => { throw new Error('Unexpected egress'); }), wait: async () => ({ ok: true, value: undefined }) };
    const webhooks = bindAgentPluginBackends(ports).ingestWebhook;
    const host = { identity, clock, observer, webhooks };
    return { native, identity, host, ports, states, loadModule, access, clock, ids, events, observer,
        rebindIdentity: () => bindIdentity(identityInput),
        advance() { instant++; }, mismatch() { bindingConnection = 'other'; },
        handle: (request: HttpRequest) => handleMessagingWebhook({ ...host, request, context }),
        close() { native.close(); } };
}

/** Signed form independently constructed from the configured external URL and every field. */
function request(required: { fields?: Record<string, string> } = {}): HttpRequest {
    const fields = { AccountSid: accountId, MessageSid: 'SM' + 'c'.repeat(32), To: '+15555550200', From: phone, Body: 'STOP', MessageStatus: 'received', ...required.fields };
    const canonical = webhookUrl + Object.keys(fields).sort().map(key => key + fields[key as keyof typeof fields]).join('');
    return { method: 'POST', path, headers: { 'x-twilio-signature': createHmac('sha1', card.authToken).update(canonical).digest('base64') },
        readRawBody: async () => ({ ok: true, value: Buffer.from(new URLSearchParams(fields).toString()) }) };
}
function evidenceId(required: { eventId: string }): string {
    return createHash('sha256').update([pluginId, connectionId, required.eventId].join('|')).digest('hex');
}

it('turns a signed STOP into durable suppression in read_only mode and accepts exact/conflicting replays', async () => {
    const f = await fixture({});
    try {
        const subject = value({ result: await f.identity.contacts.upsert({ context, identifiers: [{ kind: 'phone', raw: phone }] }) });
        expect(await f.handle(request())).toEqual({ status: 204, contentType: 'text/plain; charset=utf-8', body: '' });
        expect(await f.handle(request())).toMatchObject({ status: 204 });
        f.advance(); // Same event ID with a different recordedAt/start causes the real policy conflict branch.
        expect(await f.handle(request())).toMatchObject({ status: 204 });
        const rebound = f.rebindIdentity();
        expect(value({ result: await rebound.policy.snapshot({ context, subjectId: subject.subjectId }) }).suppressions)
            .toEqual([{ channel: 'sms', start: 1000, end: 253402300799999 }]);
        const rows = f.native.prepare('SELECT * FROM policy_evidence').all();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: evidenceId({ eventId: 'SM' + 'c'.repeat(32) + ':stop' }), source_id: pluginId });
        expect(JSON.stringify(rows)).not.toMatch(/15555550100|fixture-auth-token|fixture-key-secret|STOP/);
        expect(f.ports.fetch).not.toHaveBeenCalled();
    } finally { f.close(); }
});
it('acknowledges unknown contacts, deliveries and phone-less preferences without evidence or contact creation', async () => {
    const f = await fixture({});
    try {
        expect(await f.handle(request())).toMatchObject({ status: 204 });
        expect(await f.handle(request({ fields: { MessageStatus: 'delivered', From: '+15555550200', To: phone, Body: '' } }))).toMatchObject({ status: 204 });
        f.loadModule.mockResolvedValue({ ingestWebhook: async () => ({ ok: true, value: { events: [{ kind: 'stop', eventId: 'preference', channel: 'fixture-channel', userId: 'opaque-user' }] } }) });
        expect(await f.handle(request())).toMatchObject({ status: 204 });
        expect(f.native.prepare('SELECT * FROM policy_evidence').all()).toEqual([]);
        expect(await f.identity.contacts.resolve({ context, identifier: { kind: 'phone', raw: phone } })).toMatchObject({ ok: false });
        expect(f.events).toContainEqual({ operation: 'server.messaging.webhook.unmapped_count', outcome: '1', correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
        expect(JSON.stringify(f.events)).not.toMatch(/15555550100|opaque-user|fixture-auth-token/);
    } finally { f.close(); }
});
it.each(['unknown', 'disabled', 'unadmitted', 'mismatch', 'credential', 'exportless'])('returns the same 404 for %s plugins with pre-load lifecycle/binding/credential gates', async mode => {
    const f = await fixture({});
    try {
        const state = f.states.get(pluginId)!;
        if (mode === 'unknown') f.states.delete(pluginId);
        if (mode === 'disabled') state.enabled = false;
        if (mode === 'unadmitted') state.admitted = false;
        if (mode === 'mismatch') f.mismatch();
        if (mode === 'credential') f.access.mockRejectedValue(new Error('fixture-key-secret ' + phone));
        if (mode === 'exportless') f.loadModule.mockResolvedValue({});
        expect(await f.handle(request())).toEqual({ status: 404, body: { ok: false, error: { code: 'unavailable', message: 'Webhook unavailable', retryable: false } } });
        if (mode !== 'exportless') expect(f.loadModule).not.toHaveBeenCalled();
        expect(f.native.prepare('SELECT * FROM policy_evidence').all()).toEqual([]);
    } finally { f.close(); }
});
it('refuses forged signatures and oversize bodies with no phone or credential in errors', async () => {
    const f = await fixture({});
    try {
        const forged = await f.handle({ ...request(), headers: { 'x-twilio-signature': 'A'.repeat(27) + '=' } });
        expect(forged.status).toBe(401);
        expect(await f.handle({ ...request(), readRawBody: async () => ({ ok: true, value: Buffer.alloc(131073) }) })).toMatchObject({ status: 413 });
        expect(JSON.stringify(forged)).not.toMatch(/15555550100|fixture-auth-token|fixture-key-secret/);
        expect(f.native.prepare('SELECT * FROM policy_evidence').all()).toEqual([]);
    } finally { f.close(); }
});
it('validates a complete stop batch before writes and retries real policy failures without exposing errors', async () => {
    const f = await fixture({});
    try {
        const subject = value({ result: await f.identity.contacts.upsert({ context, identifiers: [{ kind: 'phone', raw: phone }] }) });
        const stop = { kind: 'stop', eventId: 'fixture-stop', recipient: phone, channel: 'fixture-channel' };
        for (const events of [[stop, { ...stop, recipient: 'invalid' }], Array.from({ length: 101 }, () => stop)]) {
            f.loadModule.mockResolvedValue({ ingestWebhook: async () => ({ ok: true, value: { events } }) });
            expect(await f.handle(request())).toMatchObject({ status: 400 });
            expect(f.native.prepare('SELECT * FROM policy_evidence').all()).toEqual([]);
        }
        f.loadModule.mockResolvedValue({ ingestWebhook: async () => ({ ok: true, value: { events: [stop] } }) });
        const append = vi.spyOn(f.identity.policy, 'appendEvidence').mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', retryable: true, message: 'fixture-key-secret ' + phone } });
        const failed = await f.handle(request());
        expect(failed.status).toBe(503);
        expect(JSON.stringify(failed)).not.toMatch(/fixture-key-secret|15555550100/);
        expect(await f.handle(request())).toMatchObject({ status: 204 });
        expect(append).toHaveBeenCalledTimes(2);
        expect(value({ result: await f.identity.policy.snapshot({ context, subjectId: subject.subjectId }) }).suppressions).toHaveLength(1);
        vi.spyOn(f.identity.contacts, 'resolve').mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', retryable: true, message: 'Database unavailable ' + phone } });
        expect(await f.handle(request())).toMatchObject({ status: 503 });
    } finally { f.close(); }
});
it('passes original bytes through the real listener to the plugin, caches JSON/raw reads and enforces the existing cap', async () => {
    const f = await fixture({});
    const observed: Uint8Array[] = [];
    const body = '{ "spacing": "\\u0041", "nonAscii": "é" }\n';
    f.loadModule.mockResolvedValue({ ingestWebhook: async ({ rawBody }: { rawBody: Uint8Array }) => { observed.push(rawBody); return { ok: true, value: { events: [] } }; } });
    const listener = createNodeHttpListener({ host: '127.0.0.1', port: 0, ids: f.ids, observer: f.observer,
        effects: { createServer, schedule: ({ callback, delayMs }) => { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer); } } });
    try {
        value({ result: await listener.start({ handle: async input => {
            const parsed = await input.readBody!({});
            if (parsed.ok) {
                expect(parsed.value).toEqual({ spacing: 'A', nonAscii: 'é' });
                expect(await input.readRawBody!({})).toEqual(await input.readRawBody!({}));
            }
            return f.handle(input);
        } }) });
        const url = listener.origin({})! + path;
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
        expect(observed).toHaveLength(1);
        expect(Buffer.from(observed[0]!)).toEqual(Buffer.from(body));
        const opaque = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
        expect(opaque.status).toBe(204);
        expect(observed).toHaveLength(2);
        expect(Buffer.from(observed[1]!)).toEqual(Buffer.from(body));
        const oversized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(131073) });
        expect(oversized.status).toBe(413);
        expect(observed).toHaveLength(2);
    } finally { await listener.stop({}); f.close(); }
});
