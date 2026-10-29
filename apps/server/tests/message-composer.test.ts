/** Messaging discovery and segment preview with a vendor-neutral fixture plugin; no credentials or egress. */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { createSqlContactRepo } from '@open-marketing/contacts';
import { createMemoryAccountDispatchLock, createMemorySafetyRepo } from '@open-marketing/safety';
import { bindAgentPluginBackends, bindAgentPluginJobs } from '../src/composition/agent-plugin-backends.js';
import { bindServerDatabase, provisionWorkspace } from '../src/composition/database.js';
import { migrationManifest } from '../src/composition/migrations.js';
import { createSubjectLane } from '../src/composition/subject-lane.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const foreign = { ownerId: 'owner', workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
type Binding = { id: string; scope: CallContext['scope']; connectionId: string; externalAccountId: string };
type Fixture = { publicOrigin?: string; bindings?: Binding[]; module?: Record<string, unknown>; connections?: { connectionId: string; pluginId: string; status: 'saved' | 'disconnected' }[]; messaging?: Set<string> };

function value<T>(required: { result: Outcome<T> }): T {
    expect(required.result.ok).toBe(true);
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}

/** Real job storage; plugin state, module, integrations and bindings are fixtures. */
async function fixture(required: Fixture = {}) {
    const native = new Database(':memory:');
    native.pragma('foreign_keys = ON');
    for (const entry of migrationManifest) native.exec(readFileSync(new URL('../../../' + entry.path, import.meta.url), 'utf8'));
    let sequence = 0;
    const clock = { now: () => 1000 }, ids = { next: () => 'composer-fixture-' + ++sequence }, observer = { observe() {} };
    const database = bindServerDatabase({ native, observer, context });
    await provisionWorkspace({ database: database.workspace, scope: context.scope });
    const bindings = required.bindings ?? [{ id: 'binding', scope: context.scope, connectionId: 'connection', externalAccountId: 'account' }];
    const connections = required.connections ?? [{ connectionId: 'connection', pluginId: 'fixture-messaging', status: 'saved' as const }];
    const messaging = required.messaging ?? new Set(['fixture-messaging']);
    const access = vi.fn(async () => ({ ok: true as const, value: { accessToken: 'fixture-secret' } }));
    const fetch = vi.fn(async () => { throw new Error('Unexpected native egress'); });
    const backends = bindAgentPluginBackends({ projectRoot: '/fixtures', clock, observer, mode: 'read_only', publicOrigin: required.publicOrigin,
        addons: { async list() { return { ok: true, value: { items: [], cursor: null } }; } },
        state: async ({ pluginId }) => ({ enabled: true, admitted: true, bundled: false, revision: 'a'.repeat(64), entryUrl: 'file:///' + pluginId + '/index.mjs', metadata: {} }),
        moduleDigest: async () => 'b'.repeat(64),
        loadModule: async ({ moduleUrl }) => messaging.has(new URL(moduleUrl).pathname.split('/')[1]!) ? required.module ?? { messageChannel: 'sms', sendMessage: async () => ({ ok: true, value: {} }), countMessageSegments: () => ({ ok: true, value: 2 }) } : { tools: [] },
        integrations: { access, async list() { return { ok: true, value: { items: connections, cursor: null } }; } },
        accounts: { async find({ externalAccountId }) { return { ok: true, value: bindings.find(row => row.externalAccountId === externalAccountId) ?? null }; } },
        accountList: { async listAccountBindings() { return { ok: true, value: { items: bindings, cursor: null } }; } },
        fetch, wait: async () => ({ ok: true, value: undefined }),
        safetyRepo: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }), accountLocks: createMemoryAccountDispatchLock({ ids }),
        subjectLane: createSubjectLane({ resolveSubject: createSqlContactRepo({ uow: database.unit }).get }),
        jobs: bindAgentPluginJobs({ unit: database.unit, clock, ids, observer }) });
    const definitions = value({ result: await backends.definitions({ context }) });
    const tool = (input: { name: string }) => definitions.find(row => row.name === input.name)!;
    return { access, fetch, tool,
        connections: () => tool({ name: 'om_message_connections' }).invoke({ context, input: {} }),
        preview: (input: { content?: string } = {}) => tool({ name: 'om_message_preview' }).invoke({ context, input: { pluginId: 'fixture-messaging', connectionId: 'connection', accountId: 'account', content: input.content ?? 'Hello' } }),
        close: () => native.close() };
}

it('lists one bound messaging connection with the server-computed callback URL as a read tool', async () => {
    const f = await fixture({ publicOrigin: 'https://om.example.test' });
    expect(f.tool({ name: 'om_message_connections' })).toMatchObject({ policy: 'read', effects: ['read'], ownerOnly: true });
    expect(f.tool({ name: 'om_message_connections' }).unavailableReason).toBeUndefined();
    expect(await f.connections()).toEqual({ ok: true, value: { items: [{ pluginId: 'fixture-messaging', connectionId: 'connection', accountId: 'account', channel: 'sms',
        inboundWebhookUrl: 'https://om.example.test/hooks/agent-plugins/fixture-messaging/connection/account' }] } });
    expect(f.access).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    f.close();
});

it('returns a null URL without a public origin or for IDs that would need escaping', async () => {
    const plain = await fixture();
    expect(value({ result: await plain.connections() })).toMatchObject({ items: [{ connectionId: 'connection', inboundWebhookUrl: null }] });
    plain.close();
    for (const connectionId of ['my connection', '..', 'a/b']) {
        const f = await fixture({ publicOrigin: 'https://om.example.test', bindings: [{ id: 'binding', scope: context.scope, connectionId, externalAccountId: 'account' }],
            connections: [{ connectionId, pluginId: 'fixture-messaging', status: 'saved' }] });
        expect(value({ result: await f.connections() })).toMatchObject({ items: [{ connectionId, inboundWebhookUrl: null }] });
        f.close();
    }
});

it('excludes foreign-scope bindings, non-messaging plugins and disconnected connections', async () => {
    const f = await fixture({ publicOrigin: 'https://om.example.test', messaging: new Set(['fixture-messaging']),
        bindings: [
            { id: 'foreign', scope: foreign, connectionId: 'connection', externalAccountId: 'foreign-account' },
            { id: 'ads', scope: context.scope, connectionId: 'ads-connection', externalAccountId: 'ads-account' },
            { id: 'gone', scope: context.scope, connectionId: 'gone-connection', externalAccountId: 'gone-account' },
        ],
        connections: [{ connectionId: 'connection', pluginId: 'fixture-messaging', status: 'saved' }, { connectionId: 'ads-connection', pluginId: 'fixture-ads', status: 'saved' },
            { connectionId: 'gone-connection', pluginId: 'fixture-messaging', status: 'disconnected' }] });
    expect(await f.connections()).toEqual({ ok: true, value: { items: [] } });
    f.close();
});

it('previews segments from the plugin counter, null without one, and refuses malformed output', async () => {
    const counted = await fixture();
    expect(await counted.preview()).toEqual({ ok: true, value: { segments: 2 } });
    expect(counted.access).not.toHaveBeenCalled();
    expect(counted.fetch).not.toHaveBeenCalled();
    counted.close();
    const sendMessage = async () => ({ ok: true, value: {} });
    const missing = await fixture({ module: { messageChannel: 'whatsapp', sendMessage } });
    expect(await missing.preview()).toEqual({ ok: true, value: { segments: null } });
    missing.close();
    for (const output of [{ ok: true, value: 1.5 }, { ok: true, value: '2' }, 2, null]) {
        const malformed = await fixture({ module: { messageChannel: 'sms', sendMessage, countMessageSegments: () => output } });
        expect(await malformed.preview()).toMatchObject({ ok: false });
        malformed.close();
    }
    const refused = await fixture({ module: { messageChannel: 'sms', sendMessage, countMessageSegments: () => ({ ok: false, error: { code: 'invalid_input' } }) } });
    expect(await refused.preview()).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    refused.close();
});

it('refuses preview for an unbound connection before loading a counter', async () => {
    const f = await fixture({ bindings: [] });
    expect(await f.preview()).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
    expect(await f.connections()).toEqual({ ok: true, value: { items: [] } });
    f.close();
});
