/** Retained chart inventory. OM admits enabled, Jini-verified snapshots; request paths never reach the filesystem. */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AdmittedBrowserProvider } from '@jini-ai/plugins/host';
import { callContextSchema, chartProviderListSchema } from '@open-marketing/contracts';
import type { CallContext, ChartProviderDescriptor, ObserverPort, Outcome } from '@open-marketing/contracts';
import { addonBoundary, addonFailure } from '../addons.js';
import type { HttpRequest, HttpResponse } from '../ports.js';

type RetainedAsset = { url: string; bytes: Uint8Array; contentType: string };
type RetainedProvider = { descriptor: ChartProviderDescriptor; assets: RetainedAsset[] };

/** Instance-owned bytes, replaced only after the complete admission batch validates.
 * Disable/removal drops both inventory and new asset access. Already delivered JS cannot be revoked.
 * @example const charts = createChartAssets({}); charts.replace({ pluginId, providers });
 * @throws Invalid metadata, corrupt bytes, duplicate ids or the 100-provider/32 MiB inventory cap.
 * @complexity O(retained bytes + providers) per replacement; reads scan <=200 assets.
 */
export function createChartAssets(_required: Record<string, never>) {
    const plugins = new Map<string, RetainedProvider[]>();
    return {
        replace(input: { pluginId: string; providers: readonly AdmittedBrowserProvider[] }): void {
            const others = [...plugins.entries()].filter(([id]) => id !== input.pluginId).flatMap(([, rows]) => rows);
            if (others.length + input.providers.length > 100) throw new RangeError('Chart provider cap');
            let remaining = 33554432 - retainedBytes({ providers: others });
            const retained: RetainedProvider[] = [];
            for (const provider of input.providers) {
                const row = retainProvider({ pluginId: input.pluginId, provider, remaining });
                remaining -= retainedBytes({ providers: [row] });
                retained.push(row);
            }
            const next = others.concat(retained);
            chartProviderListSchema.parse({ providers: next.map(row => row.descriptor) });
            if (new Set(next.map(row => row.descriptor.id)).size !== next.length) throw new Error('Duplicate chart provider');
            if (retained.length) plugins.set(input.pluginId, retained);
            else plugins.delete(input.pluginId);
        },
        remove(input: { pluginId: string }): void { plugins.delete(input.pluginId); },
        list(_input: Record<string, never>) {
            return chartProviderListSchema.parse({ providers: [...plugins.values()].flatMap(rows => rows.map(row => row.descriptor)) });
        },
        read(input: { path: string }): { bytes: Uint8Array; contentType: string } | undefined {
            const asset = [...plugins.values()].flatMap(rows => rows.flatMap(row => row.assets)).find(asset => asset.url === input.path);
            return asset ? { bytes: asset.bytes.slice(), contentType: asset.contentType } : undefined;
        },
        dispose(_input: Record<string, never>): void { plugins.clear(); },
    };
}
export type ChartAssets = ReturnType<typeof createChartAssets>;

/** Copy admitted bytes once; only declared client assets become HTTP-visible. */
function retainProvider(required: { pluginId: string; provider: AdmittedBrowserProvider; remaining: number }): RetainedProvider {
    const { provider, pluginId } = required;
    if (provider.pluginId !== pluginId) throw new Error('Chart plugin identity mismatch');
    const javascript = retainAsset({ provider, path: provider.declaration.javascript, contentType: 'text/javascript', remaining: required.remaining });
    const stylesheet = provider.declaration.stylesheet
        ? retainAsset({ provider, path: provider.declaration.stylesheet, contentType: 'text/css', remaining: required.remaining - javascript.bytes.byteLength }) : undefined;
    const descriptor = chartProviderListSchema.parse({ providers: [{ id: provider.declaration.id, pluginId,
        version: provider.version, contractVersion: provider.declaration.contractVersion, kinds: [...provider.declaration.kinds],
        digest: createHash('sha256').update(javascript.bytes).digest('hex'), javascript: javascript.url,
        ...(stylesheet ? { stylesheet: stylesheet.url } : {}) }] }).providers[0];
    return { descriptor, assets: stylesheet ? [javascript, stylesheet] : [javascript] };
}

/** Recheck the retained copy, including its digest; never serve an undeclared file. */
function retainAsset(required: { provider: AdmittedBrowserProvider; path: string; contentType: string; remaining: number }): RetainedAsset {
    const asset = required.provider.assets.find(asset => asset.path === required.path);
    if (!asset || asset.contentType !== required.contentType) throw new Error('Chart asset missing');
    const source = asset.readBytes({});
    if (source.byteLength > required.remaining) throw new RangeError('Chart asset byte cap');
    const bytes = source.slice();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (asset.digest !== 'sha256-' + digest) throw new Error('Chart asset integrity failed');
    const url = '/api/addons/v1/chart-assets/' + digest + '/' + basename(asset.path);
    return { url, bytes, contentType: required.contentType };
}

/** Counts bytes across the bounded inventory before retaining another provider. */
function retainedBytes(required: { providers: RetainedProvider[] }): number {
    return required.providers.flatMap(row => row.assets).reduce((total, asset) => total + asset.bytes.byteLength, 0);
}

/** Owner-authenticated GET handlers. Composition must select this handler after cookie/origin auth.
 * No cache retention: disabling a provider closes subsequent asset requests immediately.
 * @example await handleChartAssetRequest({ request, context, charts, observer });
 * @returns Inventory, retained bytes, or a bounded/redacted HTTP error; no body or disk reads.
 */
export async function handleChartAssetRequest(required: { request: HttpRequest; context: CallContext; charts: ChartAssets; observer: ObserverPort }): Promise<HttpResponse> {
    const context = callContextSchema.safeParse(required.context);
    if (!context.success) return failureResponse({ status: 400, outcome: addonFailure({ code: 'invalid_input' }) });
    if (context.data.principal.kind !== 'owner' || context.data.principal.ownerId !== context.data.scope.ownerId) {
        return failureResponse({ status: 403, outcome: addonFailure({ code: 'forbidden' }) });
    }
    const result = await addonBoundary({ context: context.data, dependencies: required, operation: 'addons.charts.read', run: async () => {
        if (required.request.method !== 'GET' || Object.keys(required.request.query ?? {}).length) return addonFailure({ code: 'invalid_input' });
        return { ok: true, value: chartResponse(required) };
    } });
    return result.ok ? result.value : failureResponse({ status: 400, outcome: result });
}

/** Only exact digest routes are keys; encoded separators/traversal never become paths. */
function chartResponse(required: { request: HttpRequest; charts: ChartAssets }): HttpResponse {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (required.request.path === '/api/addons/v1/chart-providers') return { status: 200, body: { ok: true, value: required.charts.list({}) }, headers };
    const valid = /^\/api\/addons\/v1\/chart-assets\/[a-f0-9]{64}\/[A-Za-z0-9_.-]+$/.test(required.request.path);
    const asset = valid ? required.charts.read({ path: required.request.path }) : undefined;
    return asset ? { status: 200, body: Buffer.from(asset.bytes), contentType: asset.contentType, headers }
        : failureResponse({ status: 404, outcome: addonFailure({ code: 'invalid_input' }) });
}

function failureResponse(required: { status: number; outcome: Outcome<unknown> }): HttpResponse {
    return { status: required.status, body: required.outcome, headers: { 'cache-control': 'no-store' } };
}
