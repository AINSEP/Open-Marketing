/** Written-only A2 persistence and real composed broker fixtures; no vendor traffic. */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { removeStateRoot } from './state-root.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteChatStore } from '@jini-ai/chat/store/sqlite';
import { createDurableRunStore, createChatRunLedger } from '@jini-ai/chat/store/runtime';
import type { ChatStore, ChatStoreFactory, ChatConversation } from '@jini-ai/chat/store';
import type { ChatMessage as JiniMessage } from '@jini-ai/chat';
import type { StorageKernel } from '@jini-ai/db/kernel';
import type { CallContext, ModelProvider, Outcome, RunEvent, RunGrantMetadata } from '@open-marketing/contracts';
import { assistantSettingsStatusSchema, modelProviderSchema } from '@open-marketing/contracts';
import { emptyUsage } from '../src/model-protocols.js';
import { createConversations } from '../src/conversations.js';
import { createAssistantRuns, type AssistantDatabase } from '../src/runs.js';
import { bindServerDatabase } from '../src/composition/database.js';
import { bindModelCredentials, bootServer } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { readLocalOwner } from '../src/composition/local-auth.js';
import type { ModelUpstream } from '../src/inbound/model.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
function value<T>(required: { result: Outcome<T> }): T { if (!required.result.ok) throw new Error(required.result.error.message); return required.result.value; }

/** Reuse provider manifests as declaration fixtures; the catalog/state doubles never access keys. */
const providerDeclarations: Record<string, ModelProvider> = Object.fromEntries(['anthropic', 'openai', 'google'].map(id => {
 const manifest = JSON.parse(readFileSync(new URL(`../../../content/agent-plugins/${id}/plugin.json`, import.meta.url), 'utf8'));
 return [id, modelProviderSchema.parse(manifest.extensions['io.github.ainsep.openmarketing'].modelProvider)];
}));
function modelAddons(required: { providers: Record<string, ModelProvider> }): NonNullable<Parameters<typeof createConversations>[0]['addons']> {
 return { addons: { async list() { return { ok: true, value: { items: Object.entries(required.providers).map(([id, declaration]) => ({
  id, kind: 'agent-plugin' as const, name: declaration.label, description: '', version: '1', enabled: true, revision: 'fixture-revision' })), cursor: null } }; } },
  async agentPluginState({ pluginId }) {
   const declaration = required.providers[pluginId];
   return declaration ? { enabled: true, admitted: true, bundled: false, revision: 'fixture-revision', metadata: { provides: ['model'], modelProvider: declaration }, capabilities: [] } : null;
  } };
}

/** Owner-bound in-memory transcript double. The same suite below exercises the real Jini SQLite adapter. */
function memoryStores(required: { now(): number }): ChatStoreFactory {
 const conversations = new Map<string, { scope: string; conversation: ChatConversation; messages: JiniMessage[] }>();
 return ({ scope }) => {
  const key = JSON.stringify(scope);
  const owned = (input: { id: string }) => { const row = conversations.get(input.id); return row?.scope === key ? row : undefined; };
  const store: ChatStore = {
   async list() { return [...conversations.values()].filter(row => row.scope === key).map(row => row.conversation); },
   async get(input) { return owned(input)?.conversation ?? null; },
   async create(input) {
    if (conversations.has(input.id)) throw new Error('Duplicate conversation');
    const conversation = { id: input.id, title: input.title ?? null, titleSource: input.titleSource ?? 'fallback', messageCount: 0, createdAt: required.now(), updatedAt: required.now() };
    conversations.set(input.id, { scope: key, conversation, messages: [] }); return conversation;
   },
   async rename(input) { const row = owned(input); if (!row) return null; row.conversation = { ...row.conversation, title: input.title }; return row.conversation; },
   async touch() {}, async delete(input) { if (owned(input)) conversations.delete(input.id); },
   async messages(input) { return structuredClone(owned({ id: input.conversationId })?.messages ?? []); },
   async appendMessage(input) {
    const row = owned({ id: input.conversationId }); if (!row) return null;
    const index = row.messages.findIndex(message => message.id === input.message.id);
    if (index < 0) row.messages.push(structuredClone(input.message)); else row.messages[index] = structuredClone(input.message);
    return structuredClone(input.message);
   },
   async pageConversations(_input, options) { return { items: (await store.list()).slice(0, options?.limit ?? 50) }; },
   async pageMessages(input, options) { return { items: (await store.messages(input)).slice(0, options?.limit ?? 50) }; },
   history: { async list() { return []; }, async read(input, options) {
    const messages = await store.messages({ conversationId: input.chatId });
    return { messages: messages.slice(-(options?.limit ?? 50)).map((message, position) => ({ ...message, position })), hasMore: messages.length > (options?.limit ?? 50) };
   } },
  };
  return store;
 };
}
async function fixture(required: { adapter?: 'memory' | 'sqlite'; integrations?: Parameters<typeof createConversations>[0]['integrations']; addons?: Parameters<typeof createConversations>[0]['addons'] | null } = {}) {
 const native = new Database(':memory:'); native.pragma('foreign_keys = ON');
 native.exec(await readFile(join(projectRoot, 'apps/server/migrations/0001_assistant.sql'), 'utf8'));
 native.exec(await readFile(join(projectRoot, 'apps/server/migrations/0005_chat_backend.sql'), 'utf8'));
 let now = 1000; const clock = { now: () => now }; let id = 0; const ids = { next: () => 'id-' + ++id }; const observer = { observe() {} };
 const db = bindServerDatabase({ native, context, observer });
 const sql: Parameters<typeof createConversations>[0]['db'] = { query: input => db.unit.transaction({ work: ({ session }) => session.query(input) }) };
 const kernel = db.kernel as unknown as StorageKernel<AssistantDatabase>;
 const addons = required.addons === null ? undefined : required.addons ?? modelAddons({ providers: providerDeclarations });
 const conversations = createConversations({ addons, stores: required.adapter === 'memory' ? memoryStores({ now: () => 1000 }) : ({ scope }) => createSqliteChatStore({ kernel, scope }, { clock: { nowMs: () => 1000 } }),
  db: { query: input => db.unit.transaction({ work: ({ session }) => session.query(input) }) }, kernel, ids, observer,
  integrations: required.integrations ?? { async list() { return { ok: true, value: { items: [], cursor: null } }; } } });
 const runs = createAssistantRuns({ kernel, conversations, clock, ids, observer, media: { readImage: async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: 'unused', retryable: false } }) }, durable: createDurableRunStore({ kernel, isDaemonRunId: () => true }), ledger: createChatRunLedger({ kernel, isDaemonRunId: () => true }) });
 return { conversations, runs, kernel, native, sql, addons, advance() { now += 8000; }, close() { native.close(); } };
}

for (const adapter of ['memory', 'sqlite'] as const) describe('owner transcript / ' + adapter, () => {
 it('history is scoped, and repeated stable message IDs replace one turn', async () => {
  const f = await fixture({ adapter });
  try {
   const chat = value({ result: await f.conversations.create({ context }) });
   const store = f.conversations.store({ context });
   await store.appendMessage({ conversationId: chat.conversationId, message: { id: 'question', role: 'user', content: 'original' } });
   await store.appendMessage({ conversationId: chat.conversationId, message: { id: 'question', role: 'user', content: 'updated' } });
   expect(value({ result: await f.conversations.read({ context, conversationId: chat.conversationId, query: { limit: 100 } }) }).messages).toMatchObject([{ id: 'question', role: 'user', text: 'updated' }]);
   const foreign = { ...context, scope: { ...context.scope, workspaceId: 'other' } };
   expect(value({ result: await f.conversations.list({ context: foreign, query: { limit: 100 } }) }).items).toEqual([]);
   expect(await f.conversations.read({ context: foreign, conversationId: chat.conversationId, query: { limit: 100 } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
   expect(await f.conversations.store({ context: foreign }).appendMessage({ conversationId: chat.conversationId, message: { id: 'foreign', role: 'user', content: 'forged' } })).toBeNull();
  } finally { f.close(); }
 });
 it('defaults to labeled Sandbox and reports unready configured model without falling back', async () => {
  const f = await fixture({ adapter });
  try {
   expect(value({ result: await f.conversations.settings({ context }) })).toMatchObject({ settings: { mode: 'sandbox', model: 'sandbox' }, ready: true, status: 'sandbox' });
   expect(value({ result: await f.conversations.setSettings({ context, settings: { mode: 'model', model: 'claude-opus-5-5', connectionId: null } }) })).toMatchObject({ ready: false, status: 'disconnected' });
   let launched = false;
   const result = await f.runs.start({ context, prompt: 'fixture', async launch() { launched = true; return { ok: true, value: { runId: 'wrong', status: 'pending' } }; } });
   expect(result.ok).toBe(false); expect(launched).toBe(false);
  } finally { f.close(); }
 });
});

it.each(['sandbox', 'ready', 'reconnect_required', 'disconnected', 'unavailable'] as const)('returns configured choices with settings status %s', async status => {
 const f = await fixture({ integrations: { async list() {
  if (status === 'unavailable') return { ok: false, error: { code: 'unavailable', message: 'fixture outage', retryable: false } };
  return { ok: true, value: { items: [{ pluginId: 'anthropic', connectionId: 'fixture', status: status === 'ready' ? 'saved' : 'reconnect_required' }], cursor: null } };
 } } });
 try {
  const mode = status === 'sandbox' ? 'sandbox' : 'model'; const connectionId = status === 'disconnected' ? 'missing' : 'fixture';
  const current = value({ result: await f.conversations.setSettings({ context, settings: { mode, model: 'claude-opus-5-5', connectionId } }) });
  expect(current.status).toBe(status);
  expect(current.models?.map(({ id, label }) => ({ id, label }))).toEqual(providerDeclarations.anthropic.models.map(({ id, label }) => ({ id, label })));
  for (const model of current.models!) expect((await f.conversations.setSettings({ context, settings: { ...current.settings, model: model.id } })).ok).toBe(true);
  if (mode === 'model') expect(await f.conversations.setSettings({ context, settings: { ...current.settings, provider: 'anthropic', model: 'unknown' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  value({ result: await f.conversations.setSettings({ context, settings: current.settings }) });
  const saved = value({ result: await f.conversations.settings({ context }) });
  expect(saved.settings.model).toBe('claude-opus-5-5'); expect(assistantSettingsStatusSchema.safeParse(saved).success).toBe(true);
 } finally { f.close(); }
});

it('bounds strict model choices and accepts settings responses without choices', () => {
 const status = { settings: { mode: 'sandbox', model: 'fixture', connectionId: null }, ready: true, status: 'sandbox' };
 const choice = { id: 'fixture', label: 'Fixture' };
 expect(assistantSettingsStatusSchema.safeParse(status).success).toBe(true);
 expect(assistantSettingsStatusSchema.safeParse({ ...status, models: Array(64).fill(choice) }).success).toBe(true);
 for (const models of [Array(65).fill(choice), [{ ...choice, id: '' }], [{ ...choice, label: '' }], [{ ...choice, label: 'x'.repeat(81) }], [{ ...choice, extra: true }]]) {
  expect(assistantSettingsStatusSchema.safeParse({ ...status, models }).success).toBe(false);
 }
});

async function accepted(required: { f: Awaited<ReturnType<typeof fixture>> }) {
 const receipt = value({ result: await required.f.runs.start({ context, prompt: 'question', async launch(input) {
  const messages = await required.f.conversations.store({ context }).messages({ conversationId: input.conversationId });
  expect(messages.map(message => [message.role, message.content])).toEqual([['user', 'question'], ['assistant', '']]);
  return { ok: true, value: { runId: input.runId, status: 'pending', expiresAt: input.expiresAt, conversationId: input.conversationId, mode: input.mode } };
 } }) });
 return receipt;
}
function event(required: { runId: string; sequence: number; kind: RunEvent['kind']; text?: string }): RunEvent {
 return { protocolVersion: 1, eventId: 'event-' + required.sequence, runId: required.runId, sequence: required.sequence, correlationId: context.correlationId, traceId: context.traceId, kind: required.kind,
  payload: required.kind === 'delta' ? { text: required.text ?? 'partial' } : {} };
}
it('Jini commits acceptance before launch; exact duplicates persist once, changed duplicates and gaps fail', async () => {
 const f = await fixture();
 try {
  const receipt = await accepted({ f }); const first = event({ runId: receipt.runId, sequence: 1, kind: 'started' });
  value({ result: await f.runs.record({ context, event: first }) }); value({ result: await f.runs.record({ context, event: first }) });
  expect(await f.runs.record({ context, event: { ...first, payload: { forged: true } } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 3, kind: 'delta' }) })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(value({ result: await f.runs.events({ context, runId: receipt.runId, after: 0 }) }).events).toEqual([first]);
 } finally { f.close(); }
});
it('restart retains partial text/cursors, adds interruption and never relaunches a billed turn', async () => {
 const f = await fixture();
 try {
  const receipt = await accepted({ f });
  value({ result: await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 1, kind: 'started' }) }) });
  value({ result: await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 2, kind: 'delta', text: 'Saved work' }) }) });
  value({ result: await f.runs.initialize({ context }) }); value({ result: await f.runs.initialize({ context }) });
  const page = value({ result: await f.runs.events({ context, runId: receipt.runId, after: 0 }) });
  expect(page.status).toBe('interrupted'); expect(page.events.map(item => item.kind)).toEqual(['started', 'delta', 'error']);
  const chats = value({ result: await f.conversations.list({ context, query: { limit: 100 } }) });
  expect(value({ result: await f.conversations.read({ context, conversationId: chats.items[0].conversationId, query: { limit: 100 } }) }).messages.at(-1)?.text).toBe('Saved work');
  expect((await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 4, kind: 'ended' }) })).ok).toBe(false);
 } finally { f.close(); }
});
it('cancellation is terminal and cannot be replaced by a late successful event', async () => {
 const f = await fixture();
 try {
  const receipt = await accepted({ f });
  value({ result: await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 1, kind: 'started' }) }) });
  value({ result: await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 2, kind: 'cancelled' }) }) });
  expect(await f.runs.record({ context, event: event({ runId: receipt.runId, sequence: 3, kind: 'ended' }) })).toMatchObject({ ok: false, error: { code: 'expired' } });
  expect(value({ result: await f.runs.events({ context, runId: receipt.runId, after: 0 }) }).status).toBe('cancelled');
 } finally { f.close(); }
});

/** Real Jini in the independent built agent -> mounted handleModelRequest -> injected SSE upstream.
 * Coordinator builds first and runs sockets. No test imports the agent implementation into server.
 */
it('composes an agent Jini turn through the REAL server broker and a fixture upstream', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'om-a2-chain-')); const studioRoot = join(directory, 'studio'); const stateRoot = join(directory, 'state');
 await mkdir(studioRoot); await writeFile(join(studioRoot, 'index.html'), '<head><title>fixture</title></head>');
 const upstreamRequests: Parameters<ModelUpstream['send']>[0][] = [];
 const upstream: ModelUpstream = { deadline({ timeoutMs }) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); return { signal: controller.signal, dispose: () => clearTimeout(timer) }; },
  async send(input) {
   upstreamRequests.push(input);
   const frames = [{ type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Composed fixture answer.' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
   return new Response(frames.map(data => 'event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } };
 const boot = await bootServer({ env: { OM_STATE_ROOT: stateRoot }, clock: { now: () => Date.now() }, ids: { next: () => randomUUID() }, observer: { observe() {} },
  io: { ...createNodeBootIo({ projectRoot, studioRoot, ready() {} }), modelUpstream: upstream } });
 try {
  const server = value({ result: boot }); const origin = new URL(server.studioUrl).origin;
  const owner = value({ result: await readLocalOwner({ fs, stateRoot }) });
  const headers = { authorization: 'Bearer ' + owner.token, 'content-type': 'application/json' };
  async function post(required: { path: string; body: unknown }) {
   const response = await fetch(origin + required.path, { method: 'POST', headers, body: JSON.stringify(required.body) });
   expect(response.status).toBe(200); return await response.json();
  }
  await post({ path: '/api/addons/v1/integrations/token', body: { pluginId: 'anthropic', connectionId: 'fixture-key', plaintext: 'sealed-fixture-key' } });
  await post({ path: '/api/assistant/settings', body: { mode: 'model', model: 'claude-sonnet-5-5', connectionId: 'fixture-key' } });
  const receipt = await post({ path: '/api/runs', body: { prompt: 'fixture prompt' } });
  let page: { ok: boolean; value: { status: string; events: RunEvent[] } } | undefined;
  for (let count = 0; count < 100; count++) {
   page = await (await fetch(origin + '/api/runs/' + receipt.value.runId + '/events?after=0', { headers })).json();
   if (page?.value.status !== 'running') break;
   await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  expect(page?.value.status).toBe('completed');
  expect(page?.value.events.map(item => item.kind)).toEqual(['started', 'delta', 'ended']);
  expect(upstreamRequests).toHaveLength(1);
  expect(upstreamRequests[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(upstreamRequests[0].headers['x-api-key']).toBe('sealed-fixture-key');
  expect(JSON.parse(upstreamRequests[0].body).model).toBe('claude-sonnet-5-5');
  expect(JSON.stringify(page)).not.toContain('sealed-fixture-key');
  const saved = await (await fetch(origin + '/api/conversations/' + receipt.value.conversationId + '?limit=100', { headers })).json();
  expect(saved.value.messages.at(-1).text).toBe('Composed fixture answer.');
  const continued = await post({ path: '/api/runs', body: { prompt: 'Continue saved chat', conversationId: receipt.value.conversationId } });
  expect(continued.value.conversationId).toBe(receipt.value.conversationId);
  for (let count = 0; count < 100; count++) {
   page = await (await fetch(origin + '/api/runs/' + continued.value.runId + '/events?after=0', { headers })).json();
   if (page?.value.status !== 'running') break;
   await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  expect(page?.value.status).toBe('completed'); expect(upstreamRequests).toHaveLength(2);
  expect(JSON.parse(upstreamRequests[1].body).messages).toEqual([{ role: 'user', content: 'fixture prompt' },
   { role: 'assistant', content: 'Composed fixture answer.' }, { role: 'user', content: 'Continue saved chat' }]);
  const reloaded = await (await fetch(origin + '/api/conversations/' + continued.value.conversationId + '?limit=100', { headers })).json();
  expect(reloaded.value.messages.map((message: { text: string }) => message.text)).toEqual(['fixture prompt', 'Composed fixture answer.', 'Continue saved chat', 'Composed fixture answer.']);
  expect(JSON.stringify(reloaded)).not.toContain('sealed-fixture-key');
 } finally { if (boot.ok) await boot.value.stop({}); await removeStateRoot({ path: directory }); }
});

it('freezes one provider connection at acceptance, persists usage, and excludes later turns from old totals', async () => {
 let connectionId = 'first';
 const f = await fixture({ integrations: { async list() { return { ok: true, value: { items: [{ pluginId: 'openai', connectionId, status: 'saved' }], cursor: null } }; } } });
 try {
  const status = value({ result: await f.conversations.setSettings({ context, settings: { mode: 'model', provider: 'openai', model: 'gpt-5.2', effort: 'high', connectionId: null } }) });
  expect(status.settings.connectionId).toBe('first'); expect(status.runtimes?.map(item => item.id)).toEqual(['anthropic', 'openai', 'google']);
  expect(status.runtimes?.find(item => item.id === 'google')).toMatchObject({ available: false, diagnostic: 'Connect in Integrations' });
  const first = await accepted({ f }); connectionId = 'second';
  const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'g', agentInstanceId: 'a', runId: first.runId, conversationId: first.conversationId!, scope: context.scope, capabilities: ['model'], expiresAt: 99999, revoked: false, authenticationEpoch: 1 };
  expect(value({ result: await f.runs.context({ grant }) })).toMatchObject({ settings: { connectionId: 'first', provider: 'openai', effort: 'high' }, protocol: 'openai' });
  const accesses: unknown[] = [];
  const credentials = bindModelCredentials({ persistence: f.runs, addons: f.addons, integrations: { async access(input) { accesses.push(input); return { ok: true, value: { accessToken: 'sealed-first' } }; } } });
  expect(value({ result: await credentials.resolveProviderKey({ grant, signal: new AbortController().signal }) })).toMatchObject({ apiKey: 'sealed-first', settings: { provider: 'openai', model: 'gpt-5.2', effort: 'high' }, declaration: providerDeclarations.openai });
  expect(accesses[0]).toMatchObject({ pluginId: 'openai', connectionId: 'first' });
  const { appendUsage } = await import('../src/model-usage.js');
  const sql = f.sql;
  // Real SQL adapter: insert evidence directly, retaining duplicate-key enforcement.
  for (const requestId of ['r1', 'r2']) {
   const base = { db: sql, grant, requestId, provider: 'openai' as const, model: 'gpt-5.2', pricing: providerDeclarations.openai.models[0].pricing, now: 1000 };
   await appendUsage({ ...base, kind: 'intent' });
   await appendUsage({ ...base, kind: 'completion', usage: { ...emptyUsage(), input: 10, output: 5, stopped: true } });
  }
  await expect(appendUsage({ db: sql, grant, requestId: 'r1', provider: 'openai', model: 'gpt-5.2', kind: 'completion', now: 1000, usage: { ...emptyUsage(), input: 10, output: 5, stopped: true } })).rejects.toThrow();
  f.advance();
  value({ result: await f.runs.record({ context, event: { ...event({ runId: first.runId, sequence: 1, kind: 'ended' }), payload: { costUsd: 999 } } }) });
  const saved = (await f.conversations.store({ context }).messages({ conversationId: first.conversationId! })).at(-1)!;
  expect(saved.events?.filter(item => item.kind === 'usage')).toHaveLength(1);
  const usage = value({ result: await f.runs.events({ context, runId: first.runId, after: 0 }) }).usage!;
  expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 10, complete: true, costBasis: 'estimated', durationMs: 8000 });
  expect(usage.costUsdMicros).toBe('176'); expect(usage.totalCostUsdMicros).toBe('176');
  const second = value({ result: await f.runs.start({ context, prompt: 'next', conversationId: first.conversationId, async launch(input) { return { ok: true, value: { ...input, status: 'pending' as const } }; } }) });
  const later = value({ result: await f.conversations.usage({ context, runId: second.runId }) });
  expect(later.complete).toBe(false); expect(later.totalCostUsdMicros).toBeUndefined();
  expect(value({ result: await f.conversations.usage({ context, runId: first.runId }) }).totalCostUsdMicros).toBe(usage.totalCostUsdMicros);
  const history = value({ result: await f.conversations.read({ context, conversationId: first.conversationId!, query: { limit: 1 } }) });
  expect(history.messages.length).toBe(1);
  const next = value({ result: await f.conversations.read({ context, conversationId: first.conversationId!, query: { limit: 1, cursor: history.cursor! } }) });
  expect(next.messages[0].usage?.totalCostUsdMicros).toBe(usage.totalCostUsdMicros);
  const secondGrant = { ...grant, runId: second.runId };
  await appendUsage({ db: sql, grant: secondGrant, requestId: 'interrupted', kind: 'intent', provider: 'openai', model: 'gpt-5.2', now: 9000 });
  value({ result: await f.runs.record({ context, event: event({ runId: second.runId, sequence: 1, kind: 'error' }) }) });
  expect(value({ result: await f.conversations.usage({ context, runId: second.runId }) }).costUsdMicros).toBeUndefined();
  expect(value({ result: await f.conversations.usage({ context: { ...context, scope: { ...context.scope, ownerId: 'foreign' } }, runId: first.runId }) }).totalCostUsdMicros).toBeUndefined();
 } finally { f.close(); }
});

it('rolls back a terminal event when usage storage fails and permits the same event after recovery', async () => {
 const f = await fixture({ integrations: { async list() { return { ok: true, value: { items: [{ pluginId: 'anthropic', connectionId: 'key', status: 'saved' }], cursor: null } }; } } });
 const query = f.kernel.query;
 try {
  value({ result: await f.conversations.setSettings({ context, settings: { mode: 'model', model: 'claude-sonnet-5-5', connectionId: 'key' } }) });
  const receipt = await accepted({ f });
  const ended = event({ runId: receipt.runId, sequence: 1, kind: 'ended' });
  f.kernel.query = async () => { throw new Error('Fixture usage read unavailable'); };
  expect(await f.runs.record({ context, event: ended })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(f.native.prepare('SELECT status,retained_bytes FROM om_assistant_runs WHERE run_id=?').get(receipt.runId))
   .toEqual({ status: 'running', retained_bytes: 0 });
  expect(f.native.prepare('SELECT sequence FROM om_assistant_events WHERE run_id=?').all(receipt.runId)).toEqual([]);
  f.kernel.query = query;
  value({ result: await f.runs.record({ context, event: ended }) });
  expect(value({ result: await f.runs.events({ context, runId: receipt.runId, after: 0 }) }))
   .toMatchObject({ status: 'completed', events: [ended], usage: { complete: false, costBasis: 'unavailable' } });
 } finally { f.kernel.query = query; f.close(); }
});

it('caps durable request intents at 25 and leaves interrupted outcomes unavailable', async () => {
 const f = await fixture({ integrations: { async list() { return { ok: true, value: { items: [{ pluginId: 'anthropic', connectionId: 'key', status: 'saved' }], cursor: null } }; } } });
 try {
  value({ result: await f.conversations.setSettings({ context, settings: { mode: 'model', model: 'claude-sonnet-5-5', connectionId: 'key' } }) });
  const acceptedRun = await accepted({ f });
  const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'g', agentInstanceId: 'a', runId: acceptedRun.runId, conversationId: acceptedRun.conversationId!, scope: context.scope, capabilities: ['model'], expiresAt: 99999, revoked: false, authenticationEpoch: 1 };
  const { appendUsage } = await import('../src/model-usage.js');
  const base = { db: f.sql, grant, provider: 'anthropic' as const, model: 'claude-sonnet-5-5', kind: 'intent' as const, now: 1000 };
  for (let n = 0; n < 25; n++) await appendUsage({ ...base, requestId: String(n) });
  await expect(appendUsage({ ...base, requestId: '26' })).rejects.toThrow('Model request limit reached');
  expect(value({ result: await f.conversations.usage({ context, runId: acceptedRun.runId }) })).toMatchObject({ complete: false, costBasis: 'unavailable' });
 } finally { f.close(); }
});

it.each(['disabled', 'missing'] as const)('refuses a %s selected plugin before credential access without scanning the catalog', async state => {
 const f = await fixture({ adapter: 'memory', integrations: { async list() { return { ok: true, value: { items: [{ pluginId: 'openai', connectionId: 'key', status: 'saved' }], cursor: null } }; } } });
 try {
  value({ result: await f.conversations.setSettings({ context, settings: { mode: 'model', provider: 'openai', model: 'gpt-5.2', connectionId: 'key' } }) });
  const receipt = await accepted({ f });
  const grant: RunGrantMetadata = { protocolVersion: 1, grantId: 'g', agentInstanceId: 'a', runId: receipt.runId, conversationId: receipt.conversationId!, scope: context.scope, capabilities: ['model'], expiresAt: 99999, revoked: false, authenticationEpoch: 1 };
  const current = await f.addons!.agentPluginState({ context, pluginId: 'openai' });
  const read = vi.spyOn(f.addons!, 'agentPluginState').mockResolvedValue(state === 'missing' ? null : { ...current!, enabled: false });
  const catalog = vi.spyOn(f.addons!.addons, 'list');
  const access = vi.fn(async () => ({ ok: true as const, value: { accessToken: 'must-not-be-read' } }));
  const credentials = bindModelCredentials({ persistence: f.runs, addons: f.addons, integrations: { access } });
  const result = await credentials.resolveProviderKey({ grant, signal: new AbortController().signal });
  expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(access).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pluginId: 'openai' }));
  expect(JSON.stringify(result)).not.toContain('must-not-be-read');
 } finally { f.close(); }
});

it.each([false, true])('projects declarations and resolves a legacy provider only when its model is unique (ambiguous=%s)', async ambiguous => {
 const declaration = modelProviderSchema.parse({ protocol: 'openai', endpoint: 'https://models.example.test', label: 'Acme models',
  models: [{ id: 'custom-chat', label: 'Custom chat', efforts: [{ id: 'careful', label: 'Careful', request: { reasoning_effort: 'high' } }] }] });
 const providers: Record<string, ModelProvider> = ambiguous ? { 'acme-models': declaration, 'second-models': { ...declaration, label: 'Second models' } } : { 'acme-models': declaration };
 const addons = modelAddons({ providers });
 const f = await fixture({ adapter: 'memory', addons, integrations: { async list() { return { ok: true, value: { items: [{ pluginId: 'acme-models', connectionId: 'fixture-key', status: 'saved' }], cursor: null } }; } } });
 try {
  const settings = { mode: 'model' as const, model: 'custom-chat', effort: 'careful', connectionId: null };
  // A pre-existing row, not an owner write, exercises missing-provider readiness directly.
  await f.sql.query({ text: 'INSERT INTO om_assistant_settings(owner_id,workspace_id,settings_json) VALUES ($1,$2,$3)', values: [context.scope.ownerId, context.scope.workspaceId, JSON.stringify(settings)] });
  const current = value({ result: await f.conversations.settings({ context }) });
  expect(current.runtimes?.map(runtime => [runtime.id, runtime.name])).toEqual(Object.entries(providers).map(([id, provider]) => [id, provider.label]));
  expect(current.ready).toBe(!ambiguous);
  if (ambiguous) {
   expect(current.status).toBe('unavailable');
   expect(await f.conversations.setSettings({ context, settings })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  } else {
   expect(current.settings).toMatchObject({ provider: 'acme-models', connectionId: 'fixture-key' });
   expect(current.models).toEqual([{ id: 'custom-chat', label: 'Custom chat', reasoning: [{ id: 'careful', label: 'Careful' }] }]);
   const chat = value({ result: await f.conversations.create({ context }) });
   const catalog = vi.spyOn(addons.addons, 'list');
   const read = vi.spyOn(addons, 'agentPluginState');
   expect(value({ result: await f.conversations.modelContext({ context, conversationId: chat.conversationId, settings: current.settings }) })).toMatchObject({ protocol: 'openai', settings: current.settings });
   expect(read).toHaveBeenCalledTimes(1); expect(catalog).not.toHaveBeenCalled();
   read.mockResolvedValue(null);
   expect(await f.conversations.modelContext({ context, conversationId: chat.conversationId, settings: current.settings })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  }
 } finally { f.close(); }
});

it('keeps Sandbox usable with no addon dependency and leaves a saved model selection unavailable', async () => {
 const f = await fixture({ adapter: 'memory', addons: null });
 try {
  expect(value({ result: await f.conversations.settings({ context }) })).toMatchObject({ settings: { mode: 'sandbox', model: 'sandbox' }, runtimes: [], models: [], ready: true });
  const receipt = await accepted({ f }); expect(receipt.mode).toBe('sandbox');
  const settings = { mode: 'model', provider: 'missing-models', model: 'custom-chat', connectionId: 'key' };
  await f.sql.query({ text: 'INSERT INTO om_assistant_settings(owner_id,workspace_id,settings_json) VALUES ($1,$2,$3)', values: [context.scope.ownerId, context.scope.workspaceId, JSON.stringify(settings)] });
  expect(value({ result: await f.conversations.settings({ context }) })).toMatchObject({ ready: false, status: 'unavailable', runtimes: [] });
 } finally { f.close(); }
});
