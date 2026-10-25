/** Provider snapshots for composition; pages and chat never own plugin admission or loading. */
import { chartProviderListSchema } from '@open-marketing/contracts';
import type { ChartProviderDescriptor, Outcome } from '@open-marketing/contracts';
import { createChartProviderRegistry } from '@jini-ai/ui/charts';
import type { ChartInstance, ChartProvider, ChartProviderRegistry } from '@jini-ai/ui/charts';
import { loadChartProvider } from '@jini-ai/ui/charts/browser';

export interface StudioChartDependencies {
    /** Abort the previous snapshot on disable/replacement/unmount. Host owns any load deadline. */
    readonly signal: AbortSignal;
    /** Installs CSS and returns its removal callback; the document is supplied by composition. */
    readonly loadStylesheet: (required: { url: string; signal: AbortSignal }) => Promise<() => void>;
}
type ProviderInput = { descriptor: ChartProviderDescriptor; importModule: (required: { url: string }) => Promise<unknown>; dependencies: StudioChartDependencies };

/** Validate server inventory before any effect; imports/CSS load lazily through Jini's provider ABI.
 * Abort revokes old mounts and releases their CSS, including loads that finish after disable.
 * Empty inventories and failed providers use Jini's data-table fallback.
 * @example await loadStudioChartProviders({ descriptors, importModule, dependencies: { signal, loadStylesheet } });
 * @returns Immutable Jini registry, or invalid_input; provider load failures reach Jini's fallback.
 * @complexity O(providers), <=100 entries; one module/CSS load per used entry per snapshot.
 */
export async function loadStudioChartProviders(required: { descriptors: unknown; importModule: ProviderInput['importModule']; dependencies: StudioChartDependencies }): Promise<Outcome<ChartProviderRegistry>> {
    const parsed = chartProviderListSchema.safeParse({ providers: required.descriptors });
    if (!parsed.success) return invalidInventory();
    const descriptors = parsed.data.providers;
    if (new Set(descriptors.map(row => row.id)).size !== descriptors.length) return invalidInventory();
    if (descriptors.some(row => !row.javascript.startsWith('/api/addons/v1/chart-assets/' + row.digest + '/'))) return invalidInventory();
    const providers = descriptors.map(descriptor => {
        let pending: Promise<ChartProvider> | undefined;
        return { id: descriptor.id, kinds: descriptor.kinds, enabled: true,
            load: () => pending ??= loadProvider({ ...required, descriptor }) };
    });
    return { ok: true, value: createChartProviderRegistry({ providers }) };
}

/** A stylesheet is released on load failure or snapshot abort; late completions cannot mount. */
async function loadProvider(required: ProviderInput): Promise<ChartProvider> {
    const { signal } = required.dependencies;
    assertActive({ signal });
    let release: (() => void) | undefined;
    const cleanup = () => { const previous = release; release = undefined; previous?.(); };
    signal.addEventListener('abort', cleanup, { once: true });
    try {
        if (required.descriptor.stylesheet) release = await required.dependencies.loadStylesheet({ url: required.descriptor.stylesheet, signal });
        assertActive({ signal });
        const provider = await loadChartProvider({ url: required.descriptor.javascript }, { importModule: required.importModule });
        assertActive({ signal });
        return revocableProvider({ provider, signal });
    } catch {
        signal.removeEventListener('abort', cleanup);
        cleanup();
        throw new Error('Chart provider unavailable');
    }
}

/** Foreign mount/update/destroy ABI is wrapped once. Revocation reports through Jini's onError
 * so mounted charts reveal the table immediately; a disabled snapshot cannot mount again.
 */
function revocableProvider(required: { provider: ChartProvider; signal: AbortSignal }): ChartProvider {
    return { mount(input, options) {
        assertActive(required);
        const instance = required.provider.mount(input, options);
        let destroyed = false;
        const destroy = () => {
            if (destroyed) return;
            destroyed = true;
            required.signal.removeEventListener('abort', revoke);
            instance.destroy({});
        };
        const revoke = () => {
            try { destroy(); } catch { /* The same error channel below restores Jini's table. */ }
            options?.onError?.(new Error('Chart provider disabled'));
        };
        required.signal.addEventListener('abort', revoke, { once: true });
        if (required.signal.aborted) revoke();
        const wrapped: ChartInstance = { ready: instance.ready,
            update(next) { if (destroyed) return; assertActive(required); return instance.update(next); }, destroy };
        return wrapped;
    } };
}

function assertActive(required: { signal: AbortSignal }): void {
    if (required.signal.aborted) throw new Error('Chart provider disabled');
}
function invalidInventory(): Outcome<never> {
    return { ok: false, error: { code: 'invalid_input', message: 'Invalid chart provider inventory', retryable: false } };
}
