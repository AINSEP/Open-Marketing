/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createStudioApp } from '../src/composition/index.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createNoopObservabilityPort } from '@jini-ai/diagnostics/observability';
import { captureEventSchema } from '@open-marketing/contracts';
import type { CaptureEvent, Outcome } from '@open-marketing/contracts';
import { createHttpStudioApi, createSampleStudioApi, instrumentStudioApi } from '../src/shared/api/index.js';
import { sampleCards } from '../src/shared/api/sample-data.js';
import { Events } from '../src/app/shell/Events.js';
import { StudioErrorBoundary } from '../src/app/shell/StudioErrorBoundary.js';
import { testRuntime } from './support/runtime.js';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const viewed = { kind: 'product', name: 'screen.viewed', at: 1000, screen: 'settings' } as const;
const failed = { ok: false, error: { code: 'unavailable', message: 'private-fixture', retryable: false } } as const;
const recorded = { ok: true, value: { status: 'recorded' } } as const;
/** Both concrete adapters pass the same wire/privacy fixtures; fetch is local and rejects unknown routes. */
for (const mode of ['sample', 'http'] as const) it(mode + ' validates capture/read and excludes tainted fields and server traces', async () => {
  const { runtime } = testRuntime(); const items: CaptureEvent[] = [];
  const api = mode === 'sample' ? createSampleStudioApi({ runtime }) : createHttpStudioApi({ runtime, baseUrl: 'http://localhost', observer: { observe() {} },
    fetch: async (url, init) => {
      expect(String(url)).toBe('http://localhost/api/dev/events');
      if (init?.method === 'POST') items.push(captureEventSchema.parse(JSON.parse(String(init.body))));
      return new Response(JSON.stringify(init?.method === 'POST' ? recorded : { ok: true, value: { items } }));
    } });
  expect(await api.captureEvent!({ event: viewed })).toEqual(recorded);
  expect(await api.recentEvents!({})).toEqual({ ok: true, value: { items: [viewed] } });
  for (const event of [{ ...viewed, token: 'secret' }, { ...viewed, screen: 'x'.repeat(2049) }, { kind: 'trace', name: 'approval.submit', at: 1000, correlationId: 'c', traceId: 't', outcome: 'recorded' }]) {
    expect((await api.captureEvent!({ event: event as typeof viewed })).ok).toBe(false);
  }
  expect(await api.recentEvents!({})).toEqual({ ok: true, value: { items: [viewed] } });
});
it('sample eviction is oldest first, defensive and isolated per instance', async () => {
  const { runtime } = testRuntime(); const api = createSampleStudioApi({ runtime });
  for (let at = 0; at <= 100; at++) await api.captureEvent!({ event: { ...viewed, at } });
  const result = await api.recentEvents!({}); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Missing fixture events');
  expect(result.value.items.map(item => item.at)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  result.value.items.length = 0; expect(await createSampleStudioApi({ runtime }).recentEvents!({})).toEqual({ ok: true, value: { items: [] } });
  const reread = await api.recentEvents!({}); expect(reread.ok && reread.value.items.length).toBe(100);
});
it('capture caps four in flight, drops excess without a queue, and recovers from rejection', async () => {
  const { runtime } = testRuntime(); const api = createSampleStudioApi({ runtime });
  const pending = Promise.withResolvers<Outcome<{ status: 'recorded' }>>(); const captureEvent = vi.fn(() => pending.promise);
  const instrumented = instrumentStudioApi({ api: { ...api, captureEvent }, runtime, observability: createNoopObservabilityPort({}) });
  for (let i = 0; i < 8; i++) instrumented.runtime.track('screen.viewed', { screen: 'settings' });
  expect(captureEvent).toHaveBeenCalledTimes(4); pending.reject(new Error('private-fixture')); await Promise.resolve();
  instrumented.runtime.track('screen.viewed', { screen: 'settings' }); expect(captureEvent).toHaveBeenCalledTimes(5);
  expect(await instrumented.api.snapshot({})).toMatchObject({ ok: true });
});
it('one click/request/failure pair uses existing headers and preserves the response and invocation count', async () => {
  const { runtime } = testRuntime(); const card = sampleCards({ clock: runtime.clock })[0]; const items: CaptureEvent[] = []; let writes = 0;
  let headers = new Headers();
  const raw = createHttpStudioApi({ runtime, baseUrl: 'http://localhost', observer: { observe() { throw new Error('observer'); } }, fetch: async (url, init) => {
    if (String(url) === 'http://localhost/api/dev/events') { items.push(captureEventSchema.parse(JSON.parse(String(init?.body)))); return new Response(JSON.stringify(recorded)); }
    expect(String(url)).toBe('http://localhost/api/safety/approvals/' + card.cardId + '/answer');
    headers = new Headers(init?.headers); writes++; return new Response(JSON.stringify(failed), { status: 503 });
  } });
  const observability = { ...createNoopObservabilityPort({}), trackRequest() { return { end() { throw new Error('tracker'); } }; } };
  const { api, runtime: observed } = instrumentStudioApi({ api: raw, runtime, observability });
  observed.track('approval.clicked', { cardId: card.cardId, operationId: card.operationId, choice: 'allow', durationMs: 12 });
  expect(await api.approve({ response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } })).toEqual({
    ok: false, error: { code: 'unavailable', message: 'Write response unavailable; outcome unknown. Refresh before another submission.', retryable: false },
  });
  expect(writes).toBe(1); expect(items.map(item => item.name)).toEqual(['approval.clicked', 'approval.submit_failed']);
  expect(items[0]).toMatchObject({ correlationId: headers.get('x-correlation-id'), traceId: headers.get('x-trace-id') });
  expect(items[1]).toMatchObject({ correlationId: headers.get('x-correlation-id'), traceId: headers.get('x-trace-id'), errorCode: 'unavailable' });
  expect(headers.get('idempotency-key')).toBe(headers.get('x-correlation-id')); expect(JSON.stringify(items)).not.toContain('private-fixture');
});
it('each throwing diagnostic destination preserves approval results and invocation count', async () => {
  for (const fault of ['clock', 'ids', 'capture', 'tracker']) {
    const { runtime } = testRuntime(); const raw = createSampleStudioApi({ runtime });
    const response = { cardId: 'c', operationId: 'o', argumentsDigest: 'a'.repeat(64), choice: 'cancel' } as const;
    const approve = vi.fn(async () => recorded); const throwing = () => { throw new Error('diagnostic'); };
    const observed = instrumentStudioApi({ api: { ...raw, approve, captureEvent: fault === 'capture' ? throwing : raw.captureEvent },
      runtime: { ...runtime, ids: fault === 'ids' ? { next: throwing } : runtime.ids, clock: fault === 'clock' ? { now: throwing } : runtime.clock },
      observability: { ...createNoopObservabilityPort({}), ...(fault === 'tracker' ? { trackRequest: throwing } : {}) } });
    expect(() => observed.runtime.track('approval.clicked', { cardId: 'c', operationId: 'o', choice: 'cancel', durationMs: 0 })).not.toThrow();
    expect(await observed.api.approve({ response })).toEqual(recorded); expect(approve).toHaveBeenCalledTimes(1);
  }
});
it('Events displays capture on manual Refresh and reports absent capability', async () => {
  const { runtime } = testRuntime(); const api = createSampleStudioApi({ runtime });
  render(createElement(Events, { api, runtime })); await act(async () => {}); expect(screen.getByText('No local events yet')).toBeDefined();
  await api.captureEvent!({ event: viewed }); expect(screen.queryByText('product · screen.viewed')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
  expect(screen.getByText('product · screen.viewed')).toBeDefined(); expect(screen.getByText('screen: settings')).toBeDefined();
  cleanup(); render(createElement(Events, { api: { ...api, recentEvents: undefined }, runtime })); await act(async () => {});
  expect(screen.getByText('Local events unavailable')).toBeDefined();
});
function Crashes(): never { throw new Error('secret-render-message'); }
it('the shell boundary renders a fallback and captures only screen and a fixed crash code', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); const { runtime } = testRuntime(); const raw = createSampleStudioApi({ runtime });
  const observed = instrumentStudioApi({ api: raw, runtime, observability: createNoopObservabilityPort({}) });
  render(createElement(StudioErrorBoundary, { track: observed.runtime.track, screen: () => 'campaigns' as const }, createElement(Crashes)));
  expect(screen.getByRole('alert').textContent).toContain('Reload');
  expect(await raw.recentEvents!({})).toEqual({ ok: true, value: { items: [{ kind: 'error', name: 'studio.render_crash', at: 1000, screen: 'campaigns', errorCode: 'render_crash' }] } });
});

it('production composition injects navigation capture into the sample Settings demo', async () => {
  const { runtime } = testRuntime(); const host = document.createElement('div'); document.body.append(host);
  const app = createStudioApp({ root: createRoot(host), runtime, browser: { read: () => 'settings',
    write: input => ({ ok: true, value: input.target }), listen: () => () => {} } });
  try {
    await act(async () => { app.start(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
    expect(screen.getByRole('region', { name: 'Events · local demo' }).textContent).toContain('product · screen.viewed');
    expect(screen.getByText('screen: settings')).toBeDefined();
  } finally { await act(async () => { app.stop(); }); host.remove(); }
});
