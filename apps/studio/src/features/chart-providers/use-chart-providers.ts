/** One chart snapshot per mounted consumer; no module registry or browser singleton. */
import { useEffect, useState } from 'react';
import { createChartProviderRegistry } from '@jini-ai/ui/charts';
import type { ChartProviderRegistry } from '@jini-ai/ui/charts';
import type { AppError, Outcome } from '@open-marketing/contracts';
import { loadStudioChartProviders } from './charts.js';
import type { StudioChartHost } from './browser.js';

/** Load authenticated inventory, then register lazy provider effects in Jini's neutral registry.
 * Increment revision after plugin enable/disable/install; cleanup revokes previous charts/CSS.
 * Assistant A5 consumes providers via snapshotStudioChartRegistry for its A2UI renderer.
 * @example const { providers } = useStudioChartProviders({ host, revision });
 * @returns A table-fallback registry while loading/failed/empty, plus an explicit load error.
 * @complexity O(providers), <=100 per snapshot; late responses never replace current state.
 */
export function useStudioChartProviders(required: { host: StudioChartHost; revision: string | number }): {
    providers: ChartProviderRegistry; error: AppError | null;
} {
    const [snapshot, setSnapshot] = useState<{ providers: ChartProviderRegistry; error: AppError | null }>(
        () => ({ providers: createChartProviderRegistry({ providers: [] }), error: null }));
    useEffect(() => {
        const controller = required.host.runtime.abort();
        setSnapshot({ providers: createChartProviderRegistry({ providers: [] }), error: null });
        const load = async () => {
            const inventory = await required.host.readInventory({ signal: controller.signal });
            if (controller.signal.aborted) return;
            let result: Outcome<ChartProviderRegistry>;
            if (inventory.ok) result = await loadStudioChartProviders({ descriptors: inventory.value.providers,
                importModule: required.host.importModule,
                dependencies: { signal: controller.signal, loadStylesheet: required.host.loadStylesheet } });
            else result = inventory;
            if (controller.signal.aborted) return;
            setSnapshot(result.ok ? { providers: result.value, error: null }
                : { providers: createChartProviderRegistry({ providers: [] }), error: result.error });
        };
        void load().catch(() => {
            if (controller.signal.aborted) return;
            setSnapshot({ providers: createChartProviderRegistry({ providers: [] }),
                error: { code: 'unavailable', message: 'Chart providers unavailable', retryable: false } });
        });
        return () => controller.abort();
    }, [required.host, required.revision]);
    return snapshot;
}
