/** @vitest-environment jsdom */
/** Written-only D4 lifecycle fixtures; actual Jini mounts/table renderer, injected provider I/O. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { InteractiveUiRegistry } from '@jini-ai/ui/interactive-ui';
import { createChartInteractiveRegistry } from '@jini-ai/ui/charts/react';
import type { ChartMountOptions, ChartProvider, ChartProviderRegistry, ChartSpec } from '@jini-ai/ui/charts';
import type { ChartProviderDescriptor, Outcome } from '@open-marketing/contracts';
import { createBrowserChartHost, useStudioChartProviders, loadStudioChartProviders, mountChart } from '../src/features/chart-providers/index.js';
import type { StudioChartHost } from '../src/features/chart-providers/index.js';
import type { StudioRuntime } from '../src/shared/api/index.js';

const descriptor: ChartProviderDescriptor = { id: 'uploaded.example', pluginId: 'fixture-charts', version: '1.0.0',
    digest: 'a'.repeat(64), contractVersion: 1, kinds: ['bar', 'line'],
    javascript: '/api/addons/v1/chart-assets/' + 'a'.repeat(64) + '/provider.js',
    stylesheet: '/api/addons/v1/chart-assets/' + 'b'.repeat(64) + '/styles.css' };
const spec: ChartSpec = { kind: 'bar', categoryKey: 'name', series: [{ key: 'value' }], data: [{ name: '<fixture>', value: 12 }] };
afterEach(cleanup);

function registry(required: { result: Outcome<ChartProviderRegistry> }): ChartProviderRegistry {
    if (!required.result.ok) throw new Error(required.result.error.code);
    return required.result.value;
}
function fixture(required: { ready?: Promise<void>; failUpdate?: boolean } = {}) {
    const abort = new AbortController(); const release = vi.fn(); const update = vi.fn(); const destroy = vi.fn();
    let options: ChartMountOptions | undefined;
    const mount = vi.fn<ChartProvider['mount']>((input, nextOptions) => {
        options = nextOptions;
        input.element.textContent = 'provider-rendered-fixture';
        return { ready: required.ready, update(next) { update(next); if (required.failUpdate) throw new Error('fixture update failure'); },
            destroy() { destroy(); input.element.replaceChildren(); } };
    });
    const importModule = vi.fn(async () => ({ mount }));
    const loadStylesheet = vi.fn(async () => release);
    const load = (input: { descriptors?: unknown } = {}) => loadStudioChartProviders({ descriptors: input.descriptors ?? [descriptor], importModule,
        dependencies: { signal: abort.signal, loadStylesheet } });
    return { abort, release, update, destroy, mount, importModule, loadStylesheet, load, fail() { options?.onError?.(new Error('fixture async failure')); } };
}
function element() { return document.createElement('div'); }
function fallback(required: { element: HTMLElement }): HTMLElement {
    return required.element.querySelector<HTMLElement>('[data-chart-fallback]')!;
}

it('loads JS/CSS once lazily, renders a provider, updates it, and destroys exactly once', async () => {
    const f = fixture(); const providers = registry({ result: await f.load() }); const host = element();
    expect(f.importModule).not.toHaveBeenCalled(); expect(f.loadStylesheet).not.toHaveBeenCalled();
    const mounted = mountChart({ element: host, spec, registry: providers });
    await mounted.ready;
    expect(host.textContent).toContain('provider-rendered-fixture'); expect(fallback({ element: host }).hidden).toBe(true);
    await mounted.update({ spec: { ...spec, title: 'Updated' } });
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({ title: 'Updated' }) }));
    expect(f.importModule).toHaveBeenCalledTimes(1); expect(f.importModule).toHaveBeenCalledWith({ url: descriptor.javascript });
    expect(f.loadStylesheet).toHaveBeenCalledWith({ url: descriptor.stylesheet, signal: f.abort.signal });
    mounted.destroy({}); f.abort.abort();
    expect(f.destroy).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1); expect(host.childNodes.length).toBe(0);
});

it('renders a safe data table with no provider or an unsupported chart kind', async () => {
    const f = fixture();
    for (const descriptors of [[], [descriptor]]) {
        const providers = registry({ result: await f.load({ descriptors }) }); const host = element();
        const mounted = mountChart({ element: host, spec: { ...spec, kind: 'future-kind' }, registry: providers });
        await mounted.ready;
        expect(host.querySelector('table')?.textContent).toContain('<fixture>');
        expect(host.querySelector('fixture')).toBeNull(); expect(fallback({ element: host }).hidden).toBe(false);
        mounted.destroy({});
    }
    expect(f.importModule).not.toHaveBeenCalled(); f.abort.abort();
});

it.each(['import', 'ABI', 'stylesheet'])('keeps the table when %s loading fails', async failure => {
    const f = fixture();
    const importModule = vi.fn(async () => { if (failure === 'import') throw new Error('fixture'); return failure === 'ABI' ? {} : { mount: f.mount }; });
    const loadStylesheet = vi.fn(async () => { if (failure === 'stylesheet') throw new Error('fixture'); return f.release; });
    const providers = registry({ result: await loadStudioChartProviders({ descriptors: [descriptor], importModule, dependencies: { signal: f.abort.signal, loadStylesheet } }) });
    const host = element(); const onProviderError = vi.fn();
    const mounted = mountChart({ element: host, spec, registry: providers }, { onProviderError }); await mounted.ready;
    expect(host.querySelector('table')?.textContent).toContain('12'); expect(fallback({ element: host }).hidden).toBe(false);
    expect(onProviderError).toHaveBeenCalledTimes(1); expect(f.mount).not.toHaveBeenCalled();
    mounted.destroy({}); f.abort.abort();
    if (failure !== 'stylesheet') expect(f.release).toHaveBeenCalledTimes(1);
});

it('reveals the table and tears down mounts/CSS on disable, then uses an empty replacement snapshot', async () => {
    const f = fixture(); const providers = registry({ result: await f.load() }); const host = element();
    const mounted = mountChart({ element: host, spec, registry: providers }); await mounted.ready;
    f.abort.abort(); await Promise.resolve(); await Promise.resolve();
    expect(f.destroy).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
    expect(fallback({ element: host }).hidden).toBe(false); expect(host.textContent).not.toContain('provider-rendered-fixture');
    const next = fixture(); const empty = registry({ result: await next.load({ descriptors: [] }) });
    expect(empty.list()).toEqual([]); expect(f.importModule).toHaveBeenCalledTimes(1);
    const late = mountChart({ element: element(), spec, registry: providers }); await late.ready;
    expect(f.mount).toHaveBeenCalledTimes(1); late.destroy({}); mounted.destroy({}); next.abort.abort();
});

it('invalidates an import finishing after disable before it can mount', async () => {
    const f = fixture(); const pending = Promise.withResolvers<unknown>(); const importStarted = Promise.withResolvers<void>();
    const providers = registry({ result: await loadStudioChartProviders({ descriptors: [descriptor], importModule: async () => { importStarted.resolve(); return pending.promise; },
        dependencies: { signal: f.abort.signal, loadStylesheet: f.loadStylesheet } }) });
    const host = element(); const mounted = mountChart({ element: host, spec, registry: providers });
    await importStarted.promise; f.abort.abort(); pending.resolve({ mount: f.mount }); await mounted.ready;
    expect(f.mount).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
    expect(fallback({ element: host }).hidden).toBe(false); mounted.destroy({});
});

it('releases a stylesheet finishing after disable without importing the module', async () => {
    const f = fixture(); const pending = Promise.withResolvers<() => void>(); const started = Promise.withResolvers<void>();
    const providers = registry({ result: await loadStudioChartProviders({ descriptors: [descriptor], importModule: f.importModule,
        dependencies: { signal: f.abort.signal, loadStylesheet: async () => { started.resolve(); return pending.promise; } } }) });
    const host = element(); const mounted = mountChart({ element: host, spec, registry: providers });
    await started.promise; f.abort.abort(); pending.resolve(f.release); await mounted.ready;
    expect(f.importModule).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
    expect(fallback({ element: host }).hidden).toBe(false); mounted.destroy({});
});

it('loads providers without an optional stylesheet and does no I/O for an already aborted snapshot', async () => {
    const f = fixture(); const { stylesheet: _stylesheet, ...withoutStyles } = descriptor;
    const providers = registry({ result: await f.load({ descriptors: [withoutStyles] }) });
    const mounted = mountChart({ element: element(), spec, registry: providers }); await mounted.ready;
    expect(f.mount).toHaveBeenCalledTimes(1); expect(f.loadStylesheet).not.toHaveBeenCalled(); mounted.destroy({}); f.abort.abort();
    const next = fixture(); next.abort.abort(); const inactive = registry({ result: await next.load() });
    const host = element(); const fallbackMount = mountChart({ element: host, spec, registry: inactive }); await fallbackMount.ready;
    expect(next.importModule).not.toHaveBeenCalled(); expect(next.loadStylesheet).not.toHaveBeenCalled();
    expect(fallback({ element: host }).hidden).toBe(false); fallbackMount.destroy({});
});

it('preserves the fallback while awaiting readiness and after a failed first render', async () => {
    const pending = Promise.withResolvers<void>(); const f = fixture({ ready: pending.promise });
    const providers = registry({ result: await f.load() }); const host = element();
    const mounted = mountChart({ element: host, spec, registry: providers });
    // The same lazy promise is exposed by the registry; resolving it does not resolve first paint.
    await providers.list()[0].load({}); await Promise.resolve();
    expect(fallback({ element: host }).hidden).toBe(false);
    pending.reject(new Error('fixture render failure')); await mounted.ready;
    expect(f.destroy).toHaveBeenCalledTimes(1); expect(fallback({ element: host }).hidden).toBe(false);
    mounted.destroy({}); f.abort.abort();
});

it('restores the table on update or asynchronous provider errors', async () => {
    for (const failUpdate of [true, false]) {
        const f = fixture({ failUpdate }); const providers = registry({ result: await f.load() }); const host = element();
        const mounted = mountChart({ element: host, spec, registry: providers }); await mounted.ready;
        if (failUpdate) await mounted.update({ spec });
        else { f.fail(); await Promise.resolve(); await Promise.resolve(); }
        expect(f.destroy).toHaveBeenCalledTimes(1); expect(fallback({ element: host }).hidden).toBe(false);
        mounted.destroy({}); f.abort.abort();
    }
});

it('rejects malformed, duplicate, oversized or mismatched inventory before any I/O', async () => {
    const f = fixture();
    const invalid = [[{ ...descriptor, javascript: 'https://fixture.test/provider.js' }], [descriptor, descriptor],
        [{ ...descriptor, digest: 'b'.repeat(64) }], Array.from({ length: 101 }, () => descriptor), [{ ...descriptor, contractVersion: 2 }]];
    for (const descriptors of invalid) expect(await f.load({ descriptors })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.importModule).not.toHaveBeenCalled(); expect(f.loadStylesheet).not.toHaveBeenCalled(); f.abort.abort();
});

it('uses the same A2UI wire/schema snapshot for provider selection and the table fallback', async () => {
    const f = fixture(); const providers = registry({ result: await f.load({ descriptors: [] }) });
    const snapshot = createChartInteractiveRegistry({ registry: new InteractiveUiRegistry({ entries: [] }), providers });
    const entry = snapshot.resolveById({ id: 'recharts.bar-chart' });
    expect(entry?.provider).toBe('core.table');
    const props = { data: [{ name: '<fixture>', value: 12 }], categoryKey: 'name', valueKey: 'value' };
    expect(entry?.propsSchema.safeParse(props).success).toBe(true);
    if (!entry) throw new Error('Missing chart wire entry');
    await act(async () => { render(createElement(entry.Component, props)); });
    expect(screen.getByRole('table').textContent).toContain('<fixture>');
    expect(f.importModule).not.toHaveBeenCalled(); f.abort.abort();
});

it('exposes enabled chart providers to the existing A2UI registry and renders through their ABI', async () => {
    const f = fixture(); const providers = registry({ result: await f.load() });
    const snapshot = createChartInteractiveRegistry({ registry: new InteractiveUiRegistry({ entries: [] }), providers });
    const entry = snapshot.resolveById({ id: 'recharts.bar-chart' });
    expect(entry?.provider).toBe(descriptor.id);
    if (!entry) throw new Error('Missing chart entry');
    await act(async () => { render(createElement(entry.Component, { data: [{ name: 'fixture', value: 12 }], categoryKey: 'name', valueKey: 'value' })); });
    await waitFor(() => expect(screen.getByText('provider-rendered-fixture')).toBeDefined());
    expect(f.mount).toHaveBeenCalledTimes(1);
    f.abort.abort();
});

/** Injected deadlines are fired explicitly; no real timers or HTTP are needed. */
function browserRuntime() {
    const pending = new Map<object, () => void>();
    const runtime: StudioRuntime = { clock: { now: () => 1000 }, ids: { next: () => 'fixture-trace' }, abort: () => new AbortController(),
        timers: { schedule(input) { const handle = {}; pending.set(handle, input.callback); return handle; },
            cancel(input) { pending.delete(input.handle as object); }, async wait() {} } };
    return { runtime, pending, expire() { for (const callback of [...pending.values()]) callback(); } };
}

it('loads authenticated bounded inventory with tracing, and rejects malformed/oversized responses', async () => {
    const f = fixture(); const time = browserRuntime(); const observer = { observe: vi.fn() };
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, value: { providers: [descriptor] } })));
    const host = createBrowserChartHost({ document, fetch: transport, runtime: time.runtime, observer, importModule: f.importModule });
    expect(await host.readInventory({ signal: f.abort.signal })).toEqual({ ok: true, value: { providers: [descriptor] } });
    expect(transport).toHaveBeenCalledWith('/api/addons/v1/chart-providers', expect.objectContaining({ credentials: 'same-origin', redirect: 'manual',
        headers: expect.objectContaining({ 'x-trace-id': 'fixture-trace' }) }));
    expect(observer.observe).toHaveBeenCalledWith(expect.objectContaining({ operation: 'studio.charts.inventory', outcome: 'succeeded' }));
    expect(time.pending.size).toBe(0);
    for (const body of ['{}', 'x'.repeat(262145), JSON.stringify({ ok: true, value: { providers: [descriptor, { ...descriptor, contractVersion: 2 }] } })]) {
        transport.mockResolvedValueOnce(new Response(body));
        expect(await host.readInventory({ signal: f.abort.signal })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    }
    expect(f.importModule).not.toHaveBeenCalled();
});

it('cancels inventory deadlines and never accepts a response after cancellation', async () => {
    const f = fixture(); const time = browserRuntime(); const pending = Promise.withResolvers<Response>();
    const transport = vi.fn<typeof fetch>(async () => pending.promise);
    const host = createBrowserChartHost({ document, fetch: transport, runtime: time.runtime, observer: { observe() {} }, importModule: f.importModule });
    const reading = host.readInventory({ signal: f.abort.signal });
    time.expire();
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({ ok: true, value: { providers: [] } })));
    expect(await reading).toMatchObject({ ok: false });
    expect(time.pending.size).toBe(0);
    f.abort.abort();
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, value: { providers: [] } })));
    expect(await host.readInventory({ signal: f.abort.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
});

it('installs/removes CSS and cleans up DOM listeners/deadlines on failure or cancellation', async () => {
    const f = fixture(); const time = browserRuntime();
    const host = createBrowserChartHost({ document, fetch: vi.fn(), runtime: time.runtime, observer: { observe() {} }, importModule: f.importModule });
    const loading = host.loadStylesheet({ url: descriptor.stylesheet!, signal: f.abort.signal });
    const link = document.head.querySelector('link')!;
    expect(link.getAttribute('href')).toBe(descriptor.stylesheet);
    link.dispatchEvent(new Event('load'));
    const release = await loading;
    expect(time.pending.size).toBe(0);
    f.abort.abort(); release();
    expect(link.isConnected).toBe(false);
    for (const reason of ['error', 'deadline', 'abort']) {
        const controller = new AbortController();
        const failed = host.loadStylesheet({ url: descriptor.stylesheet!, signal: controller.signal });
        const rejected = expect(failed).rejects.toThrow('unavailable');
        if (reason === 'error') document.head.querySelector('link')!.dispatchEvent(new Event('error'));
        if (reason === 'deadline') time.expire();
        if (reason === 'abort') controller.abort();
        await rejected;
        expect(document.head.querySelector('link')).toBeNull();
        expect(time.pending.size).toBe(0);
    }
    await expect(host.loadStylesheet({ url: descriptor.stylesheet!, signal: f.abort.signal })).rejects.toThrow('disabled');
});

it('refreshes the hook snapshot, cancels late inventory, and revokes charts/CSS on unmount', async () => {
    const f = fixture(); const time = browserRuntime(); const late = Promise.withResolvers<Outcome<{ providers: ChartProviderDescriptor[] }>>();
    const signals: AbortSignal[] = [];
    const readInventory = vi.fn<StudioChartHost['readInventory']>(async input => { signals.push(input.signal); return late.promise; });
    const host: StudioChartHost = { runtime: time.runtime, readInventory, loadStylesheet: f.loadStylesheet, importModule: f.importModule };
    const view = renderHook((input: { revision: number }) => useStudioChartProviders({ host, revision: input.revision }), { initialProps: { revision: 0 } });
    expect(view.result.current.providers.list()).toEqual([]);
    readInventory.mockResolvedValueOnce({ ok: true, value: { providers: [descriptor] } });
    view.rerender({ revision: 1 });
    await waitFor(() => expect(view.result.current.providers.list()).toHaveLength(1));
    expect(signals[0].aborted).toBe(true);
    await act(async () => { late.resolve({ ok: true, value: { providers: [] } }); });
    expect(view.result.current.providers.list()).toHaveLength(1);
    const mount = mountChart({ element: element(), spec, registry: view.result.current.providers });
    await mount.ready;
    expect(f.mount).toHaveBeenCalledTimes(1);
    readInventory.mockResolvedValueOnce({ ok: true, value: { providers: [] } });
    view.rerender({ revision: 2 });
    await waitFor(() => expect(view.result.current.providers.list()).toEqual([]));
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.destroy).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(signals.at(-1)?.aborted).toBe(true); mount.destroy({});
});

it('returns a table snapshot with an explicit hook error on failed inventory', async () => {
    const f = fixture(); const time = browserRuntime();
    const host: StudioChartHost = { runtime: time.runtime, importModule: f.importModule, loadStylesheet: f.loadStylesheet,
        async readInventory() { return { ok: false, error: { code: 'unavailable', message: 'fixture', retryable: false } }; } };
    const view = renderHook(() => useStudioChartProviders({ host, revision: 0 }));
    await waitFor(() => expect(view.result.current.error?.code).toBe('unavailable'));
    expect(view.result.current.providers.list()).toEqual([]);
    expect(f.importModule).not.toHaveBeenCalled(); view.unmount();
});
