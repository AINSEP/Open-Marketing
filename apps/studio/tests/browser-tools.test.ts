/** @vitest-environment jsdom */
/** A5 written-only fixtures: real Jini renderer/driver, no model or vendor calls. */
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLabCatalog, parseAgentToRendererMessage } from '@jini-ai/agentic/a2ui';
import { executePageCapability } from '@jini-ai/agentic';
import type { A2uiSurfacePayload, SurfaceAcknowledgement } from '@open-marketing/contracts';
import { A2uiSurface } from '../src/widgets/om-chat/A2uiSurface.js';
import { OMChatPane } from '../src/widgets/om-chat/OMChatPane.js';
import type { StudioChartHost } from '../src/features/chart-providers/index.js';
import { dispatchSurfaceAction, surfaceRenderStatus } from '../src/widgets/om-chat/A2uiSurface.hooks.js';
import { bindPageActions, createStudioPageDriver, createChatSession, checkedFrontendFrame } from '../src/features/chat-run/index.js';
import { createSampleStudioApi, createHttpStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);
function surface(required: { components?: unknown[]; runId?: string; frontendSessionId?: string } = {}): A2uiSurfacePayload {
    const messages = [
        { version: 'v1.0', createSurface: { surfaceId: 'surface', catalogId: createLabCatalog({}).catalogId, dataModel: {} } },
        { version: 'v1.0', updateComponents: { surfaceId: 'surface', components: required.components ?? [{ id: 'root', component: 'Text', text: 'Fixture surface' }] } },
    ];
    return { type: 'a2ui', version: 'v1.0', surfaceId: 'surface', invocationId: 'invocation', runId: required.runId ?? 'run',
        frontendSessionId: required.frontendSessionId ?? 'frontend', messages: JSON.parse(JSON.stringify(messages)) };
}
function browserFixture() {
    const host = testRuntime(); const acknowledgements: SurfaceAcknowledgement[] = [];
    const api: StudioApiPort = { ...createSampleStudioApi({ runtime: host.runtime }),
        async acknowledgeSurface({ result }) { acknowledgements.push(result); return { ok: true, value: { status: 'recorded' } }; } };
    return { host, api, acknowledgements };
}
it('uses the published surface card and reports browser mount evidence', async () => {
    const f = browserFixture(); const payload = surface();
    for (const raw of payload.messages) expect(parseAgentToRendererMessage({ raw }).ok).toBe(true);
    const mounted = render(createElement(A2uiSurface, { surface: payload, api: f.api, runtime: f.host.runtime, streaming: true, succeeded: false }));
    await waitFor(() => expect(screen.getByText('Fixture surface')).toBeTruthy());
    f.host.advance({ ms: 50 });
    await waitFor(() => expect(f.acknowledgements.map(ack => ack.status)).toContain('rendered'));
    expect(surfaceRenderStatus({ root: mounted.container, surfaceId: payload.surfaceId })).toBe('rendered');
    mounted.unmount(); expect(f.host.pending()).toBe(0);
});
it('renders neutral charts as a table without a chart plugin', async () => {
    const f = browserFixture();
    render(createElement(A2uiSurface, { surface: surface({ components: [{ id: 'root', component: 'recharts.bar-chart', data: [{ name: 'Alpha', count: 7 }], categoryKey: 'name', valueKey: 'count' }] }),
        api: f.api, runtime: f.host.runtime, streaming: false, succeeded: true }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(screen.getByText('Alpha')).toBeTruthy(); expect(screen.getByText('7')).toBeTruthy();
});
it('does not acknowledge renderer refusals as rendered', async () => {
    const f = browserFixture();
    const mounted = render(createElement(A2uiSurface, { surface: surface({ components: [{ id: 'root', component: 'Text', text: 42 }] }),
        api: f.api, runtime: f.host.runtime, streaming: false, succeeded: false }));
    await waitFor(() => expect(mounted.container.querySelector('.a2ui-surface-refused')).toBeTruthy());
    f.host.advance({ ms: 50 });
    await waitFor(() => expect(f.acknowledgements.map(ack => ack.status)).toContain('failed'));
    expect(f.acknowledgements.some(ack => ack.status === 'rendered')).toBe(false);
});
it('dispatches surface actions to catalog tools and rejects foreign surface/run identities', async () => {
    const f = browserFixture(); const calls: unknown[] = [];
    f.api.tool = async input => { calls.push(input.call); return { ok: true, value: { status: 'pending', operationId: input.call.operationId, cardId: 'card' } }; };
    const props = { surface: surface(), api: f.api, runtime: f.host.runtime, streaming: true, succeeded: false };
    const message = { version: 'v1.0', action: { name: 'om_halt_account', surfaceId: 'surface', sourceComponentId: 'root', timestamp: 'fixture', context: { accountId: 'sandbox-account' } } };
    expect(await dispatchSurfaceAction({ props, runId: 'run', message })).toMatchObject({ ok: false, reason: expect.stringContaining('approval is pending') });
    expect(calls).toEqual([expect.objectContaining({ name: 'om_halt_account', input: { accountId: 'sandbox-account' } })]);
    expect(await dispatchSurfaceAction({ props, runId: 'foreign', message })).toMatchObject({ ok: false });
    expect(await dispatchSurfaceAction({ props, runId: 'run', message: { ...message, action: { ...message.action, surfaceId: 'foreign' } } })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
});

function pageFixture() {
    const host = testRuntime(); const root = document.createElement('main');
    root.innerHTML = '<section data-agent-page="plugins"><button data-agent-element="local" data-agent-role="button">Local</button><button data-agent-element="install" data-agent-role="button">Install</button><section class="approval-card"><button data-agent-element="approve" data-agent-role="button">Approve</button></section><input data-agent-element="key" data-agent-role="field" type="password" name="api-key"><input data-agent-element="draft" data-agent-role="field"></section>';
    document.body.append(root); const navigate = vi.fn(); const scroll = vi.fn(); let active = true;
    const binding = createStudioPageDriver({ dom: { root, pages: { plugins: { label: 'Plugins', navigate } } },
        browser: { root, selection: { candidateSelector: '[data-agent-element]', excludedAncestorSelector: '.approval-card' }, allowPath: () => true,
            navigate, reducedMotion: () => true, scroll, timers: host.runtime.timers,
            highlightClass: 'fixture-highlight', fadeAnimationName: 'fixture-fade', cleanupFallbackMs: 100 },
        runtime: host.runtime, currentRun: () => active ? { runId: 'run', expiresAt: 301000 } : null,
        localWriteHandles: new Set(['local', 'draft', 'approve', 'key']) });
    return { ...binding, root, host, navigate, scroll, stop() { active = false; }, cleanup() { binding.dispose(); root.remove(); } };
}
it('uses the Jini DOM driver for local controls and refuses business/approval/credential writes', async () => {
    const f = pageFixture(); const clicked = vi.fn(); f.root.querySelector('[data-agent-element="local"]')!.addEventListener('click', clicked);
    await f.driver.click({ handle: 'local' }); expect(clicked).toHaveBeenCalledTimes(1);
    await expect(f.driver.click({ handle: 'install' })).rejects.toThrow('catalog');
    await expect(f.driver.click({ handle: 'approve' })).rejects.toThrow('unavailable');
    await expect(executePageCapability({ driver: f.driver, capabilityId: 'page.fill', input: { handle: 'key', text: 'fixture-only' } })).rejects.toThrow();
    await f.driver.fill({ handle: 'draft', text: 'Fixture text' });
    expect((f.root.querySelector('[data-agent-element="draft"]') as HTMLInputElement).value).toBe('Fixture text');
    f.stop(); await expect(f.driver.click({ handle: 'local' })).rejects.toThrow('live run'); f.cleanup();
});
it('binds Jini page-actions for highlight/scroll and cleans up on disposal', async () => {
    const f = pageFixture();
    await f.driver.highlight({ handle: 'draft', durationMs: 50 });
    expect(f.root.querySelector('.fixture-highlight')).toBeTruthy();
    await f.driver.scrollTo({ handle: 'draft' }); expect(f.scroll).toHaveBeenCalledTimes(1);
    f.dispose(); expect(f.root.querySelector('.fixture-highlight')).toBeNull();
    await expect(f.driver.navigate({ page: 'plugins' })).rejects.toThrow('live run'); f.root.remove();
});
/** EventSource ABI fixture: Jini owns subscription/deduplication; no local executor replica. */
class FixtureSource extends EventTarget {
    closed = false;
    close() { this.closed = true; }
    frame(required: { input: unknown }) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(required.input) })); }
}
it('deduplicates invocations and refreshes frontend identity after reconnect', async () => {
    const f = pageFixture(); const source = new FixtureSource(); const sent: unknown[] = []; const errors: unknown[] = [];
    const bridge = bindPageActions({ driver: f.driver, currentRun: () => ({ runId: 'run', expiresAt: 301000, frontendSessionId: 'frontend-1' }), onBound() {}, onVoided() {}, onSurface() {}, onError: input => errors.push(input.error), transport: { baseUrl: '',
        openStream: () => source as unknown as EventSource,
        request: async input => { sent.push(JSON.parse(String(input.init.body))); return new Response('{}', { status: 200 }); } } });
    source.frame({ input: { type: 'attached', sessionId: 'frontend-1', bindToken: 'fixture-token-1' } });
    await bridge.ready; expect(bridge.sessionId()).toBe('frontend-1');
    const clicked = vi.fn(); f.root.querySelector('[data-agent-element="local"]')!.addEventListener('click', clicked);
    const invocation = { type: 'invocation', invocationId: 'invocation', capabilityId: 'page.click', input: { handle: 'local' }, runId: 'run', frontendSessionId: 'frontend-1' };
    source.frame({ input: invocation }); await waitFor(() => expect(sent).toHaveLength(1));
    source.frame({ input: invocation }); await waitFor(() => expect(sent).toHaveLength(2));
    expect(clicked).toHaveBeenCalledTimes(1);
    source.dispatchEvent(new Event('error')); expect(bridge.sessionId()).toBeUndefined();
    source.frame({ input: { type: 'attached', sessionId: 'frontend-2', bindToken: 'fixture-token-2' } });
    expect(bridge.sessionId()).toBe('frontend-2'); expect(errors).toHaveLength(1);
    bridge.close(); expect(source.closed).toBe(true); expect(bridge.sessionId()).toBeUndefined(); f.cleanup();
});
it('carries frontend session identity into run-start and rejects surfaces for another browser', async () => {
    const f = browserFixture(); const requests: unknown[] = [];
    const api: StudioApiPort = { ...f.api,
        async start(input) { requests.push(input); return { ok: true, value: { runId: 'run', status: 'pending', expiresAt: 301000 } }; },
        async *events() { yield { ok: true, value: { protocolVersion: 1, eventId: 'event', runId: 'run', sequence: 1, correlationId: 'correlation', traceId: 'trace', kind: 'delta', payload: surface({ frontendSessionId: 'foreign' }) } }; },
    };
    const session = createChatSession({ api, runtime: f.host.runtime, frontendSessionId: () => 'frontend',
        async navigate({ action }) { return { status: 'completed', actionId: action.actionId, target: action.target }; } });
    await session.send({ text: 'Fixture' });
    expect(requests).toEqual([expect.objectContaining({ frontendSessionId: 'frontend' })]);
    expect(session.getSnapshot().surfaces).toEqual([]); expect(session.getSnapshot().status).toBe('unavailable'); session.dispose();
});
it('posts browser acknowledgements through the bounded HTTP adapter', async () => {
    const f = browserFixture(); const requests: { url: string; body: unknown }[] = [];
    const api = createHttpStudioApi({ baseUrl: 'http://localhost:4321', runtime: f.host.runtime, observer: { observe() {} },
        fetch: async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ ok: true, value: { status: 'recorded' } }), { status: 200 }); } });
    const result: SurfaceAcknowledgement = { status: 'rendered', surfaceId: 'surface', invocationId: 'invocation', runId: 'run', frontendSessionId: 'frontend' };
    expect(await api.acknowledgeSurface!({ result })).toEqual({ ok: true, value: { status: 'recorded' } });
    expect(requests).toEqual([{ url: 'http://localhost:4321/api/runs/run/surfaces', body: result }]);
});

it('rejects foreign invocation frames before Jini can drive the page', () => {
    const invocation = { type: 'invocation', invocationId: 'inv', runId: 'run', frontendSessionId: 'frontend', capabilityId: 'page.navigate', input: { page: 'settings' } };
    const run = { runId: 'run', frontendSessionId: 'frontend' };
    expect(checkedFrontendFrame({ input: invocation, sessionId: 'frontend', run })).toEqual({ ok: true, type: 'invocation' });
    for (const input of [null, { ...invocation, runId: 'foreign' }, { ...invocation, frontendSessionId: 'foreign' },
        { ...invocation, capabilityId: 'om_campaign_propose_launch' }, { ...invocation, input: 'x'.repeat(65536) }]) {
        expect(checkedFrontendFrame({ input, sessionId: 'frontend', run })).toMatchObject({ ok: false });
    }
    expect(checkedFrontendFrame({ input: invocation, sessionId: 'frontend', run: null })).toMatchObject({ ok: false });
});

/** One live run fixture: explicit abort releases the blocked stream without inventing completion. */
async function liveChatFixture() {
    const f = browserFixture(); const end = Promise.withResolvers<void>(); const starts: unknown[] = [];
    const api: StudioApiPort = { ...f.api,
        async start(input) { starts.push(input); return { ok: true, value: { runId: 'run', status: 'pending', expiresAt: 301000 } }; },
        async *events({ signal }) { signal.addEventListener('abort', () => end.resolve(), { once: true }); await end.promise; },
        async cancel() { return { ok: true, value: { runId: 'run', status: 'cancelled' } }; },
    };
    const session = createChatSession({ api, runtime: f.host.runtime, frontendSessionId: () => 'frontend', frontendBindToken: () => 'fixture-current-token',
        async navigate({ action }) { return { status: 'completed', actionId: action.actionId, target: action.target }; } });
    const sending = session.send({ text: 'Fixture only' }); await waitFor(() => expect(session.currentRun()?.runId).toBe('run'));
    session.receiveSurface({ input: surface() });
    return { ...f, api, starts, session, sending, async stop() { await session.cancel(); await sending; session.dispose(); } };
}
it('passes the current bind token and shows surface spend approvals in the existing inline card', async () => {
    const f = await liveChatFixture();
    const card = { cardId: 'exact-card', operationId: 'surface-op', argumentsDigest: 'a'.repeat(64), arguments: { tool: 'om_campaign_propose_launch', input: { campaignId: 'fixture' } },
        classification: 'spend' as const, allowedChoices: ['allow', 'cancel'] as const, expiresAt: 301000 };
    f.api.tool = async () => ({ ok: true, value: { status: 'pending', operationId: card.operationId, cardId: card.cardId } });
    f.api.approvalCard = async () => ({ ok: true, value: { ...card, allowedChoices: [...card.allowedChoices] } });
    const props = { surface: surface(), api: f.api, runtime: f.host.runtime, streaming: true, succeeded: false, onPendingApproval: f.session.addSurfaceApproval };
    await act(async () => { await dispatchSurfaceAction({ props, runId: 'run', message: { version: 'v1.0', action: { name: 'om_campaign_propose_launch', surfaceId: 'surface',
        sourceComponentId: 'root', timestamp: 'fixture', context: { campaignId: 'fixture' } } } }); });
    // This fixture starts headlessly; Jini reads its initial transcript only when mounted.
    const view = render(createElement(OMChatPane, { session: f.session, api: f.api, runtime: f.host.runtime, sample: false, available: true, open: true, toggle() {} }));
    expect(f.starts).toEqual([expect.objectContaining({ frontendSessionId: 'frontend', frontendBindToken: 'fixture-current-token' })]);
    expect(f.session.getSnapshot().cards).toHaveLength(1); expect(screen.getByRole('heading', { name: 'Exact spend approval' })).toBeTruthy();
    expect(screen.queryByText('Always allow')).toBeNull(); expect(screen.queryByText('Allow for this chat')).toBeNull();
    await act(async () => { await f.stop(); }); expect(f.session.getSnapshot().cards).toEqual([]); expect(screen.queryByText('Exact spend approval')).toBeNull(); view.unmount();
});
it('does not insert a different card or dispatch actions from a cancelled surface', async () => {
    const f = browserFixture(); const inserted = vi.fn(); const tool = vi.fn<NonNullable<StudioApiPort['tool']>>(async () => ({ ok: true, value: { status: 'pending', operationId: 'op', cardId: 'card' } }));
    const api = { ...f.api, tool, approvalCard: async () => ({ ok: true as const, value: { cardId: 'wrong-card', operationId: 'op', argumentsDigest: 'a'.repeat(64), arguments: {},
        classification: 'write' as const, allowedChoices: ['allow' as const, 'cancel' as const], expiresAt: 301000 } }) };
    const props = { surface: surface(), api, runtime: f.host.runtime, streaming: true, succeeded: false, onPendingApproval: inserted };
    const message = { version: 'v1.0', action: { name: 'fixture_tool', surfaceId: 'surface', sourceComponentId: 'root', timestamp: 'fixture', context: {} } };
    expect(await dispatchSurfaceAction({ props, runId: 'run', message })).toMatchObject({ ok: false, reason: expect.stringContaining('identity mismatch') });
    expect(inserted).not.toHaveBeenCalled();
    expect(await dispatchSurfaceAction({ props: { ...props, streaming: false }, runId: 'run', message })).toMatchObject({ ok: false });
    expect(tool).toHaveBeenCalledTimes(1);
});
it('shares one plugin inventory across chart surfaces and refreshes it on revision change', async () => {
    const f = await liveChatFixture(); const signals: AbortSignal[] = [];
    const mount = vi.fn((input: { element: HTMLElement }) => { input.element.textContent = 'plugin-chart-fixture'; return { update() {}, destroy() { input.element.replaceChildren(); } }; });
    const descriptor = { id: 'uploaded.fixture', pluginId: 'fixture', version: '1.0.0', digest: 'a'.repeat(64), contractVersion: 1 as const,
        kinds: ['bar'], javascript: '/api/addons/v1/chart-assets/' + 'a'.repeat(64) + '/provider.js' };
    const inventory = vi.fn<StudioChartHost['readInventory']>(async input => { signals.push(input.signal); return { ok: true, value: { providers: [descriptor] } }; });
    const importModule = vi.fn(async () => ({ mount }));
    const host: StudioChartHost = { runtime: f.host.runtime, readInventory: inventory, importModule, async loadStylesheet() { return () => {}; } };
    const chart = surface({ components: [{ id: 'root', component: 'recharts.bar-chart', data: [{ name: 'Alpha', count: 7 }], categoryKey: 'name', valueKey: 'count' }] });
    // Change identity values without changing property names.
    const other = { ...chart, surfaceId: 'surface-2', invocationId: 'invocation-2', messages: chart.messages.map(message => JSON.parse(JSON.stringify(message).replaceAll('"surface"', '"surface-2"'))) };
    f.session.receiveSurface({ input: chart }); f.session.receiveSurface({ input: other });
    const props = { session: f.session, api: f.api, runtime: f.host.runtime, sample: false, available: true, open: true, toggle() {}, charts: { host, revision: 1 } };
    const view = render(createElement(OMChatPane, props));
    await waitFor(() => expect(mount).toHaveBeenCalledTimes(2));
    expect(inventory).toHaveBeenCalledTimes(1); expect(importModule).toHaveBeenCalledTimes(1);
    view.rerender(createElement(OMChatPane, { ...props, charts: { host, revision: 2 } }));
    await waitFor(() => expect(inventory).toHaveBeenCalledTimes(2)); expect(signals[0]?.aborted).toBe(true);
    view.unmount(); expect(signals[1]?.aborted).toBe(true); await f.stop();
});

it('accepts the server binding before the start receipt and cancels its early surface card', async () => {
    const f = browserFixture(); const receipt = Promise.withResolvers<import('@open-marketing/contracts').Outcome<import('../src/shared/api/index.js').StudioRun>>();
    const cancelled: string[] = [];
    const api: StudioApiPort = { ...f.api, start: async () => receipt.promise,
        async cancel({ runId }) { cancelled.push(runId); return { ok: true, value: { runId, status: 'cancelled' } }; } };
    const session = createChatSession({ api, runtime: f.host.runtime, frontendSessionId: () => 'frontend', frontendBindToken: () => 'fixture-token',
        async navigate({ action }) { return { status: 'completed', actionId: action.actionId, target: action.target }; } });
    const sending = session.send({ text: 'Fixture' });
    session.receiveFrontendBinding({ runId: 'run', expiresAt: 301000, frontendSessionId: 'frontend' });
    expect(session.currentRun()?.runId).toBe('run'); session.receiveSurface({ input: surface() });
    session.addSurfaceApproval({ runId: 'run', card: { cardId: 'early-card', operationId: 'early-op', argumentsDigest: 'a'.repeat(64), arguments: {},
        classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 } });
    expect(session.getSnapshot().cards).toHaveLength(1); await session.cancel();
    expect(cancelled).toEqual(['run']); expect(session.getSnapshot().cards).toEqual([]); expect(session.currentRun()).toBeNull();
    receipt.resolve({ ok: true, value: { runId: 'run', status: 'pending', expiresAt: 301000 } }); await sending;
    expect(session.getSnapshot().status).toBe('cancelled'); session.dispose();
});

it('applies server cancellation frames immediately without another approval request', async () => {
    const f = await liveChatFixture();
    f.session.addSurfaceApproval({ runId: 'run', card: { cardId: 'card', operationId: 'op', argumentsDigest: 'a'.repeat(64), arguments: {},
        classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 } });
    const cancel = vi.fn(f.api.cancel); f.api.cancel = cancel;
    const frame = checkedFrontendFrame({ input: { type: 'voided', runId: 'run', frontendSessionId: 'frontend', status: 'cancelled' },
        run: f.session.currentRun(), sessionId: 'frontend' });
    if (!frame.ok || frame.type !== 'voided') throw new Error('Expected a cancellation frame');
    f.session.voidFrontendRun(frame.binding); await f.sending;
    expect(f.session.currentRun()).toBeNull(); expect(f.session.getSnapshot().cards).toEqual([]); expect(f.session.getSnapshot().status).toBe('cancelled');
    expect(cancel).not.toHaveBeenCalled(); f.session.dispose();
});

it('excludes private OAuth configuration from page discovery and refuses describing or filling it', async () => {
    const f = pageFixture();
    const panel = document.createElement('form'); panel.setAttribute('data-agent-private', 'true');
    panel.innerHTML = '<label>Private client configuration<input data-agent-element="oauth-client" data-agent-role="field" value="private-client-fixture"></label><input data-agent-element="oauth-secret" data-agent-role="field" type="password" value="private-secret-fixture">';
    f.root.append(panel);
    const elements = await f.driver.findElements({});
    expect(JSON.stringify(elements)).not.toContain('private-client-fixture');
    expect(JSON.stringify(elements)).not.toContain('private-secret-fixture');
    await expect(f.driver.describeField({ handle: 'oauth-client' })).rejects.toThrow('unavailable');
    await expect(f.driver.fill({ handle: 'oauth-secret', text: 'replacement' })).rejects.toThrow();
    f.cleanup();
});
