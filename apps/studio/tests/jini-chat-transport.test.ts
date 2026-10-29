/** Shared transport contract: memory API and injected HTTP fixtures; no vendor calls. */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RunHandlers } from '@jini-ai/chat';
import type { RunEvent } from '@open-marketing/contracts';
import { createChatSession } from '../src/features/chat-run/index.js';
import { createHttpStudioApi, createSampleStudioApi } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

function event({ sequence, kind = 'delta' }: { sequence: number; kind?: RunEvent['kind'] }): RunEvent {
  return { protocolVersion: 1, eventId: 'e-' + sequence, runId: 'run', sequence, correlationId: 'correlation', traceId: 'trace', kind,
    payload: kind === 'delta' ? { text: 'Hello' } : kind === 'error' ? { code: 'unavailable' } : {} };
}
function recorder() {
  const events: AgentEvent[] = [], statuses: unknown[] = [], errors: string[] = [], done = Promise.withResolvers<void>(); let completions = 0;
  const handlers: RunHandlers = { onEvent: value => events.push(value), onCheckpoint: message => statuses.push(message.runStatus),
    onError: error => errors.push(error.message), onDone() { completions++; done.resolve(); } };
  return { events, statuses, errors, handlers, done: done.promise, completions: () => completions };
}
function fixture({ kind, terminal = 'ended' }: { kind: 'memory' | 'http'; terminal?: 'ended' | 'cancelled' | 'error' }) {
  const host = testRuntime(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let starts = 0, cancellations = 0; const cursors: number[] = [], prompts: string[] = [];
  const receipt = { runId: 'run', status: 'pending' as const, expiresAt: 301000, conversationId: 'chat' };
  const status = { ended: 'completed', cancelled: 'cancelled', error: 'interrupted' }[terminal];
  const usage = { kind: 'usage' as const, durationMs: 8000, costUsdMicros: '70000', totalCostUsdMicros: '580000', complete: false, costBasis: 'estimated' as const };
  async function pause({ signal }: { signal?: AbortSignal }) {
    entered.resolve();
    if (signal?.aborted) return;
    const aborted = Promise.withResolvers<void>(); const abort = () => aborted.resolve();
    signal?.addEventListener('abort', abort, { once: true });
    await Promise.race([release.promise, aborted.promise]); signal?.removeEventListener('abort', abort);
  }
  const api = kind === 'http' ? createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', observer: { observe() {} },
    runtime: { ...host.runtime, timers: { ...host.runtime.timers, async wait() {} } },
    async fetch(url, options) {
      const path = new URL(String(url));
      if (path.pathname === '/api/runs') { starts++; prompts.push(JSON.parse(String(options?.body)).prompt); return Response.json({ ok: true, value: receipt }); }
      if (path.pathname.endsWith('/cancel')) { cancellations++; return Response.json({ ok: true, value: { runId: 'run', status: 'cancelled' } }); }
      const after = Number(path.searchParams.get('after')); cursors.push(after);
      if (after === 0) return Response.json({ ok: true, value: { runId: 'run', status: 'running', events: [event({ sequence: 1 })] } });
      await pause({ signal: options?.signal ?? undefined });
      return Response.json({ ok: true, value: { runId: 'run', status, events: [event({ sequence: 2, kind: terminal })], usage } });
    } }) : {
    ...createSampleStudioApi({ runtime: host.runtime }),
    async start(input: { message: { text: string } }) { starts++; prompts.push(input.message.text); return { ok: true as const, value: receipt }; },
    async *events(input: { after: number; signal: AbortSignal }) {
      cursors.push(input.after);
      if (input.after === 0) { yield { ok: true as const, value: event({ sequence: 1 }) }; yield { ok: true as const, value: event({ sequence: 1 }) }; }
      await pause({ signal: input.signal });
      if (!input.signal.aborted) yield { ok: true as const, value: event({ sequence: 2, kind: terminal }) };
    },
    async runStatus() { return { ok: true as const, value: { runId: 'run', status: status as 'completed' | 'cancelled' | 'interrupted', usage } }; },
    async cancel() { cancellations++; return { ok: true as const, value: { runId: 'run', status: 'cancelled' as const } }; },
  };
  const session = createChatSession({ api, runtime: host.runtime, frontendSessionId: () => 'frontend', async navigate({ action }) { return { status: 'completed', actionId: action.actionId, target: action.target }; } });
  const input = { history: [{ id: 'user', role: 'user' as const, content: 'hello' }], signal: new AbortController().signal };
  return { host, api, session, input, entered: entered.promise, release: () => release.resolve(), starts: () => starts, cancellations: () => cancellations, cursors, prompts };
}

describe.each(['memory', 'http'] as const)('%s session-backed Jini transport', kind => {
  it('returns acceptance before completion and retains reported usage with explicit estimate provenance', async () => {
    const f = fixture({ kind }), r = recorder();
    try {
      expect(await f.session.transport.startRun(f.input, r.handlers)).toEqual({ runId: 'run' }); await f.entered;
      expect(r.completions()).toBe(0); expect(await f.session.transport.fetchRunStatus('run')).toBe('running');
      expect(r.events).toEqual([{ kind: 'text', text: 'Hello' }]);
      f.release(); await r.done;
      expect(r.completions()).toBe(1); expect(r.statuses.at(-1)).toBe('succeeded'); expect(r.errors).toEqual([]);
      expect(r.events).toContainEqual({ kind: 'usage', durationMs: 8000, inputTokens: undefined, outputTokens: undefined, costUsd: .07 });
      expect(r.events).toContainEqual({ kind: 'ext', name: 'om.usage-evidence', data: {} });
      expect(f.starts()).toBe(1); await vi.waitFor(() => expect(f.host.pending()).toBe(0));
    } finally { f.release(); f.session.dispose(); }
  });
  it('detaches without cancelling, then reattaches from the cursor without another start', async () => {
    const f = fixture({ kind }), first = recorder(), next = recorder(), controller = new AbortController();
    try {
      await f.session.transport.startRun({ ...f.input, signal: controller.signal }, first.handlers); await f.entered;
      controller.abort(); expect(f.cancellations()).toBe(0); await vi.waitFor(() => expect(f.host.pending()).toBe(0));
      await f.session.transport.reattachRun('run', next.handlers, { signal: new AbortController().signal });
      f.release(); await next.done;
      expect(f.starts()).toBe(1); expect(first.completions()).toBe(0); expect(next.completions()).toBe(1);
      expect(next.events.filter(item => item.kind === 'text')).toEqual([]); expect(next.statuses).toEqual(['running', 'succeeded']);
      expect(f.cursors).toContain(1);
    } finally { f.release(); f.session.dispose(); }
  });
  it('reattaches an existing server run without ever calling start', async () => {
    const f = fixture({ kind }), r = recorder();
    try {
      await f.session.transport.reattachRun('run', r.handlers, { signal: f.input.signal });
      await f.entered; f.release(); await r.done;
      expect(f.starts()).toBe(0); expect(r.events).toContainEqual({ kind: 'text', text: 'Hello' });
      expect(r.completions()).toBe(1); expect(r.statuses.at(-1)).toBe('succeeded');
    } finally { f.release(); f.session.dispose(); }
  });
  it('Stop requests cancellation and emits one canceled terminal callback', async () => {
    const f = fixture({ kind }), r = recorder();
    try {
      await f.session.transport.startRun(f.input, r.handlers); await f.entered;
      await f.session.transport.stopRun('run'); await r.done; f.release();
      expect(f.cancellations()).toBe(1); expect(r.completions()).toBe(1); expect(r.statuses.at(-1)).toBe('canceled');
      expect(f.session.getSnapshot().status).toBe('cancelled'); expect(f.host.pending()).toBe(0);
    } finally { f.release(); f.session.dispose(); }
  });
  it.each([['cancelled', 'canceled'], ['error', 'failed']] as const)('maps %s without claiming success', async (terminal, expected) => {
    const f = fixture({ kind, terminal }), r = recorder();
    try {
      await f.session.transport.startRun(f.input, r.handlers); f.release(); await r.done;
      expect(r.statuses.at(-1)).toBe(expected); expect(r.completions()).toBe(1); expect(r.errors).toHaveLength(terminal === 'error' ? 1 : 0);
    } finally { f.release(); f.session.dispose(); }
  });
});
it('status drains even a short byte-limited intermediate page of a completed run', async () => {
  const host = testRuntime(), cursors: number[] = [];
  const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', runtime: host.runtime, observer: { observe() {} }, async fetch(url) {
    const after = Number(new URL(String(url)).searchParams.get('after')); cursors.push(after);
    return Response.json({ ok: true, value: { runId: 'run', status: after ? 'completed' : 'running', events: [after ? event({ sequence: 2, kind: 'ended' }) : event({ sequence: 1 })] } });
  } });
  expect(await api.runStatus!({ runId: 'run' })).toMatchObject({ ok: true, value: { runId: 'run', status: 'completed' } });
  expect(cursors).toEqual([0, 1]); expect(host.pending()).toBe(0);
});
it('status rejects foreign run identities rather than exposing another run', async () => {
  const host = testRuntime();
  const api = createHttpStudioApi({ baseUrl: 'http://127.0.0.1:31000', runtime: host.runtime, observer: { observe() {} }, async fetch() {
    return Response.json({ ok: true, value: { runId: 'foreign', status: 'completed', events: [event({ sequence: 1, kind: 'ended' })] } });
  } });
  expect(await api.runStatus!({ runId: 'run' })).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
});
it('selected add-ons add instructions; removing them removes the instruction and grants no authority', async () => {
  for (const pluginInstructions of [['Fixture plugin (fixture)'], []]) {
    const f = fixture({ kind: 'memory' }), r = recorder();
    try {
      await f.session.transport.startRun({ ...f.input, context: { pluginInstructions } }, r.handlers); f.release(); await r.done;
      expect(f.prompts[0].includes('Fixture plugin')).toBe(pluginInstructions.length > 0);
      if (pluginInstructions.length) expect(f.prompts[0]).toContain('This selection grants no authority.');
    } finally { f.release(); f.session.dispose(); }
  }
});
it('rejects unsupported image input before starting a run', async () => {
  const f = fixture({ kind: 'memory' });
  try {
    await expect(f.session.transport.startRun({ ...f.input, attachments: [{ path: 'image', name: 'image.png', kind: 'image' }] }, recorder().handlers)).rejects.toThrow('This server does not accept image attachments. Your message was not sent.');
    expect(f.starts()).toBe(0);
  } finally { f.session.dispose(); }
});
