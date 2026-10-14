/** Browser effects for the chart hook; composition injects DOM, transport and runtime. */
import { z } from 'zod';
import { appErrorSchema, chartProviderListSchema } from '@open-marketing/contracts';
import type { ChartProviderList, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { StudioRuntime } from '../../shared/api/index.js';
import type { StudioChartDependencies } from './charts.js';

export interface StudioChartHost {
    readonly runtime: StudioRuntime;
    readInventory(required: { signal: AbortSignal }): Promise<Outcome<ChartProviderList>>;
    readonly loadStylesheet: StudioChartDependencies['loadStylesheet'];
    importModule(required: { url: string }): Promise<unknown>;
}
const inventoryEnvelope = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value: chartProviderListSchema }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema }),
]);

/** Same-origin inventory/CSS effects, no dependency construction or global browser reads.
 * Inventory is capped at 256 KiB/15s; CSS gets a 15s deadline and is removed on abort/error.
 * @example createBrowserChartHost({ document, fetch, runtime, observer, importModule });
 * @complexity O(response bytes), <=256 KiB; one inventory read and lazy CSS/import per provider.
 */
export function createBrowserChartHost(required: {
    document: Document; fetch: typeof fetch; runtime: StudioRuntime; observer: ObserverPort;
    importModule: StudioChartHost['importModule'];
}): StudioChartHost {
    return { runtime: required.runtime, importModule: required.importModule,
        readInventory: input => readInventory({ ...required, signal: input.signal }),
        loadStylesheet: input => stylesheet({ ...required, ...input }),
    };
}
type BrowserInput = Parameters<typeof createBrowserChartHost>[0];

/** Validate the entire envelope before exposing any rows. Aborts never acknowledge success. */
async function readInventory(required: BrowserInput & { signal: AbortSignal }): Promise<Outcome<ChartProviderList>> {
    const controller = required.runtime.abort();
    const abort = () => controller.abort();
    required.signal.addEventListener('abort', abort, { once: true });
    if (required.signal.aborted) abort();
    const timer = required.runtime.timers.schedule({ delayMs: 15000, callback: abort });
    const correlationId = required.runtime.ids.next({});
    const traceId = required.runtime.ids.next({});
    let outcome = 'unavailable';
    try {
        const response = await required.fetch('/api/addons/v1/chart-providers', { credentials: 'same-origin', redirect: 'manual',
            signal: controller.signal, headers: { accept: 'application/json', 'x-correlation-id': correlationId, 'x-trace-id': traceId } });
        const body = await inventoryBody({ response });
        const parsed = inventoryEnvelope.safeParse(body);
        if (!parsed.success || (parsed.data.ok && !response.ok)) throw new Error('Invalid chart inventory');
        if (controller.signal.aborted) throw new Error('Chart inventory interrupted');
        outcome = parsed.data.ok ? 'succeeded' : parsed.data.error.code;
        return parsed.data;
    } catch {
        const code = required.signal.aborted ? 'cancelled' : 'unavailable';
        outcome = code;
        return { ok: false, error: { code, message: 'Chart providers unavailable', retryable: false } };
    } finally {
        controller.abort();
        required.signal.removeEventListener('abort', abort);
        required.runtime.timers.cancel({ handle: timer });
        try { required.observer.observe({ operation: 'studio.charts.inventory', outcome, correlationId, traceId }); }
        catch { /* Diagnostics cannot replace the inventory result. */ }
    }
}

/** Stream with a byte cap rather than trusting Content-Length; always release the reader. */
async function inventoryBody(required: { response: Response }): Promise<unknown> {
    const reader = required.response.body?.getReader();
    if (!reader) throw new Error('Missing chart inventory');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 262144) throw new Error('Chart inventory cap');
            text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode()) as unknown;
    } finally {
        try { await reader.cancel(); }
        finally { reader.releaseLock(); }
    }
}

/** DOM event ABI is confined here; the link and all listeners/timers share one cleanup. */
function stylesheet(required: BrowserInput & { url: string; signal: AbortSignal }): Promise<() => void> {
    if (required.signal.aborted) return Promise.reject(new Error('Chart snapshot disabled'));
    const link = required.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = required.url;
    return new Promise((resolve, reject) => {
        const release = () => { link.remove(); required.signal.removeEventListener('abort', failed); };
        const finish = () => {
            link.removeEventListener('load', loaded); link.removeEventListener('error', failed);
            required.runtime.timers.cancel({ handle: timer });
        };
        const failed = () => { finish(); release(); reject(new Error('Chart stylesheet unavailable')); };
        const loaded = () => { finish(); resolve(release); };
        const timer = required.runtime.timers.schedule({ delayMs: 15000, callback: failed });
        link.addEventListener('load', loaded, { once: true });
        link.addEventListener('error', failed, { once: true });
        required.signal.addEventListener('abort', failed, { once: true });
        required.document.head.append(link);
    });
}
