/** Written-only streaming/history/cancellation regressions using fixture transports. */
import { expect, it } from 'vitest';
import type { RunEvent } from '@open-marketing/contracts';
import { createChatSession } from '../src/features/chat-run/index.js';
import { createHttpStudioApi, createSampleStudioApi, parseStudioEvent } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

function event(required: { sequence: number; kind?: RunEvent['kind']; payload?: RunEvent['payload'] }): RunEvent {
 return { protocolVersion: 1, eventId: 'e-' + required.sequence, runId: 'run', sequence: required.sequence, correlationId: 'correlation', traceId: 'trace',
  kind: required.kind ?? 'delta', payload: required.payload ?? { text: 'a' } };
}
function fixture(required: { api?: Partial<StudioApiPort> } = {}) {
 const host = testRuntime();
 const api: StudioApiPort = { ...createSampleStudioApi({ runtime: host.runtime }),
  async start() { return { ok: true, value: { runId: 'run', conversationId: 'chat', mode: 'model', status: 'pending', expiresAt: 301000 } }; },
  ...required.api };
 const session = createChatSession({ api, runtime: host.runtime, async navigate({ action }) { return { status: 'completed', actionId: action.actionId, target: action.target }; } });
 return { host, api, session };
}
it('rejects malformed display payloads as typed failures without throwing', () => {
 const payloads: RunEvent['payload'][] = [{ type: 'message', message: { id: 'reply', role: 'assistant', text: 42 } }, { type: 'confirmation', card: {} }];
 for (const payload of payloads) {
  expect(parseStudioEvent({ input: event({ sequence: 1, payload }) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
 }
});
it('streams beyond 1,000 events, deduplicates repeated deltas and accumulates one assistant message', async () => {
 const f = fixture({ api: { async *events() {
  yield { ok: true, value: event({ sequence: 1, kind: 'started', payload: {} }) };
  for (let sequence = 2; sequence <= 1201; sequence++) {
   const delta = event({ sequence }); yield { ok: true, value: delta }; yield { ok: true, value: delta };
  }
  yield { ok: true, value: event({ sequence: 1202, kind: 'ended', payload: {} }) };
 } } });
 await f.session.send({ text: 'fixture' });
 expect(f.session.getSnapshot().status).toBe('complete');
 expect(f.session.getSnapshot().messages.filter(message => message.role === 'assistant')).toEqual([{ id: 'run-reply', role: 'assistant', text: 'a'.repeat(1200) }]);
 expect(f.host.pending()).toBe(0); f.session.dispose();
});
it('accepts 8,192 unique events including the terminal slot and rejects event 8,193', async () => {
 const accepted = fixture({ api: { async *events() {
  yield { ok: true, value: event({ sequence: 1, kind: 'started', payload: {} }) };
  for (let sequence = 2; sequence < 8192; sequence++) yield { ok: true, value: event({ sequence, payload: { text: '' } }) };
  yield { ok: true, value: event({ sequence: 8192, kind: 'ended', payload: {} }) };
 } } });
 await accepted.session.send({ text: 'fixture' }); expect(accepted.session.getSnapshot().status).toBe('complete'); accepted.session.dispose();
 const exceeded = fixture({ api: { async *events() {
  for (let sequence = 1; sequence <= 8193; sequence++) yield { ok: true, value: event({ sequence, payload: { text: '' } }) };
 } } });
 await exceeded.session.send({ text: 'fixture' }); expect(exceeded.session.getSnapshot().status).toBe('unavailable');
 expect(exceeded.session.getSnapshot().notice).toContain('Event limit reached'); exceeded.session.dispose();
});
it('rejects conflicting replay, a cursor gap and a changed trace identity', async () => {
 for (const second of [event({ sequence: 1, payload: { text: 'changed' } }), event({ sequence: 3 }), { ...event({ sequence: 2 }), traceId: 'foreign' }]) {
  const f = fixture({ api: { async *events() { yield { ok: true, value: event({ sequence: 1 }) }; yield { ok: true, value: second }; } } });
  await f.session.send({ text: 'fixture' }); expect(f.session.getSnapshot().status).toBe('unavailable');
  expect(f.session.getSnapshot().messages.at(-1)?.text).toBe('a'); f.session.dispose();
 }
});
it('loads a saved conversation and passes its identity into the next shared run', async () => {
 const requests: unknown[] = [];
 const f = fixture({ api: {
  async conversations() { return { ok: true, value: { items: [{ conversationId: 'chat', title: 'Saved chat', createdAt: 1000, updatedAt: 1000 }], cursor: null } }; },
  async settings() { return { ok: true, value: { settings: { mode: 'sandbox', model: 'claude-sonnet-5-5', connectionId: null }, ready: true, status: 'sandbox' } }; },
  async conversation() { return { ok: true, value: { conversation: { conversationId: 'chat', title: 'Saved chat', createdAt: 1000, updatedAt: 1000 }, messages: [{ id: 'saved', role: 'assistant', text: 'Saved answer' }], cursor: null } }; },
  async start(input) { requests.push(input.conversationId); return { ok: true, value: { runId: 'run', conversationId: input.conversationId, status: 'pending', mode: 'sandbox', expiresAt: 301000 } }; },
  async *events() { yield { ok: true, value: event({ sequence: 1, kind: 'ended', payload: {} }) }; },
 } });
 await f.session.refresh(); expect(f.session.getSnapshot().conversations[0].title).toBe('Saved chat');
 await f.session.selectConversation({ conversationId: 'chat' }); expect(f.session.getSnapshot().messages[0].text).toBe('Saved answer');
 await f.session.send({ text: 'continue' }); expect(requests).toEqual(['chat']);
 await f.session.newConversation(); expect(f.session.getSnapshot().conversationId).toBeNull(); expect(f.session.getSnapshot().messages).toEqual([]); f.session.dispose();
});
it('displays actual tool completion and resolves a run-bound inline card', async () => {
 const f = fixture(); const snapshot = await f.api.snapshot({}); if (!snapshot.ok) throw new Error('Fixture snapshot unavailable');
 const card = snapshot.value.cards[0];
 const source: Partial<StudioApiPort> = { async *events() {
  yield { ok: true, value: event({ sequence: 1, kind: 'tool_requested', payload: { type: 'tool_requested', call: { name: 'fixture_tool', input: {}, operationId: card.operationId } } }) };
  yield { ok: true, value: event({ sequence: 2, kind: 'tool_requested', payload: { type: 'confirmation', card } }) };
  yield { ok: true, value: event({ sequence: 3, kind: 'tool_result', payload: { type: 'tool_result', operationId: card.operationId, result: { status: 'completed', output: { saved: true } } } }) };
  yield { ok: true, value: event({ sequence: 4, kind: 'tool_result', payload: { type: 'confirmation_resolved', operationId: card.operationId, cardId: card.cardId, status: 'completed' } }) };
  yield { ok: true, value: event({ sequence: 5, kind: 'ended', payload: {} }) };
 } };
 const run = fixture({ api: source }); await run.session.send({ text: 'fixture' });
 expect(run.session.getSnapshot().tools).toEqual([{ operationId: card.operationId, name: 'fixture_tool', status: 'completed' }]);
 expect(run.session.getSnapshot().cards).toEqual([]); run.session.dispose(); f.session.dispose();
});
it('Stop voids run cards and ignores late success after server cancellation', async () => {
 const f = fixture(); const snapshot = await f.api.snapshot({}); if (!snapshot.ok) throw new Error('Fixture snapshot unavailable');
 const card = snapshot.value.cards[0]; let cancellations = 0;
 const entered = Promise.withResolvers<void>();
 const run = fixture({ api: {
  async *events(input) {
   yield { ok: true, value: event({ sequence: 1, kind: 'tool_requested', payload: { type: 'confirmation', card } }) };
   entered.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
   yield { ok: true, value: event({ sequence: 2, kind: 'ended', payload: {} }) };
  },
  async cancel(input) { cancellations++; return { ok: true, value: { runId: input.runId, status: 'cancelled' } }; },
 } });
 const sending = run.session.send({ text: 'fixture' }); await entered.promise; expect(run.session.getSnapshot().cards).toHaveLength(1);
 await run.session.cancel(); await sending; expect(cancellations).toBe(1); expect(run.session.getSnapshot().cards).toEqual([]);
 expect(run.session.getSnapshot().status).toBe('cancelled'); run.session.dispose(); f.session.dispose();
});
it('HTTP polling requests incremental cursors and validates actual agent envelopes', async () => {
 const host = testRuntime(); const paths: string[] = [];
 const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', runtime: { ...host.runtime, timers: { ...host.runtime.timers, async wait() {} } }, observer: { observe() {} },
  async fetch(url) {
   const path = new URL(String(url)).pathname + new URL(String(url)).search; paths.push(path);
   if (path.endsWith('after=0')) return Response.json({ ok: true, value: { runId: 'run', status: 'running', events: [event({ sequence: 1 })] } });
   return Response.json({ ok: true, value: { runId: 'run', status: 'completed', events: [event({ sequence: 2, kind: 'ended', payload: {} })] } });
  } });
 const events: RunEvent[] = [];
 for await (const result of api.events({ runId: 'run', after: 0, signal: new AbortController().signal })) { if (!result.ok) throw new Error(result.error.message); events.push(result.value); }
 expect(paths).toEqual(['/api/runs/run/events?after=0', '/api/runs/run/events?after=1']); expect(events.map(item => item.kind)).toEqual(['delta', 'ended']); expect(host.pending()).toBe(0);
});
it('HTTP rejects an entire malformed/foreign page before displaying any event', async () => {
 const host = testRuntime();
 const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', runtime: host.runtime, observer: { observe() {} }, async fetch() {
  return Response.json({ ok: true, value: { runId: 'run', status: 'completed', events: [event({ sequence: 1 }), { ...event({ sequence: 2, kind: 'ended', payload: {} }), runId: 'foreign' }] } });
 } });
 const results = []; for await (const result of api.events({ runId: 'run', after: 0, signal: new AbortController().signal })) results.push(result);
 expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } }); expect(host.pending()).toBe(0);
});
it('HTTP polling reports a failed interval and silently ends an owner-cancelled interval', async () => {
 for (const cancel of [false, true]) {
  const host = testRuntime(); const controller = new AbortController(); let calls = 0;
  const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', observer: { observe() {} },
   runtime: { ...host.runtime, timers: { ...host.runtime.timers, async wait() { if (cancel) controller.abort(); throw new Error('Fixture interval interrupted'); } } },
   async fetch() { calls++; return Response.json({ ok: true, value: { runId: 'run', status: 'running', events: [event({ sequence: 1 })] } }); } });
  const results = []; for await (const result of api.events({ runId: 'run', after: 0, signal: controller.signal })) results.push(result);
  expect(results[0]).toEqual({ ok: true, value: event({ sequence: 1 }) });
  expect(results.slice(1)).toEqual(cancel ? [] : [{ ok: false, error: { code: 'unavailable', message: 'Run polling interrupted', retryable: false } }]);
  expect(calls).toBe(1); expect(host.pending()).toBe(0);
 }
});
it('HTTP polling stops at the unique event cap without waiting or fetching again', async () => {
 const host = testRuntime(); let calls = 0;
 const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', runtime: host.runtime, observer: { observe() {} },
  async fetch() { calls++; return Response.json({ ok: true, value: { runId: 'run', status: 'running', events: [event({ sequence: 8192 })] } }); } });
 const results = []; for await (const result of api.events({ runId: 'run', after: 8191, signal: new AbortController().signal })) results.push(result);
 expect(results).toEqual([{ ok: true, value: event({ sequence: 8192 }) }, { ok: false, error: { code: 'limit_exceeded', message: 'Run event limit exceeded', retryable: false } }]);
 expect(calls).toBe(1); expect(host.pending()).toBe(0);
});
