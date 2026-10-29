import { createHash } from 'node:crypto';
import { addonListRequestSchema, addonListSchema, addonSummarySchema, addonUninstallReceiptSchema,
    installAddonSchema, parseBoundary, setAddonEnabledSchema, uninstallAddonSchema } from '@open-marketing/contracts';
import type { AddonKind, AddonList, AddonSummary, AddonUninstallReceipt, CallContext, CallOptions,
    InstallAddon, Outcome, SetAddonEnabled, UninstallAddon } from '@open-marketing/contracts';
import type { AddonDependencies, AddonRepository, PreparedAddon, PluginService } from './types.js';
import { addonBoundary, addonFailure, attempt, reconciliationFailure } from './results.js';

/** Inert binding. Scope mutation overlap is refused, without another queue or outbox.
 * Every failed enable persists closed state and unregisters runtime resources before returning.
 * @example const addons = createPluginService({ repo, packages, archiveReader, observer });
 * @complexity <=1000 retained summaries per scope; upload <=32 MiB. No vendor calls.
 */
export function createPluginService(required: AddonDependencies): PluginService {
    const busy = new Set<string>();
    return {
        list: (input, options) => addonBoundary({ ...input, dependencies: required, operation: 'addons.list', run: async () => {
            const query = parseBoundary({ schema: addonListRequestSchema, input: input.query });
            if (!query.ok) return query;
            const rows = await required.repo.list(input);
            const items = rows.filter(row => !query.value.kind || row.kind === query.value.kind).sort(compareAddons);
            const offset = query.value.cursor ? items.findIndex(row => rowKey({ addon: row }) === query.value.cursor) + 1 : 0;
            if (query.value.cursor && offset === 0) return addonFailure({ code: 'invalid_input' });
            const page = items.slice(offset, offset + query.value.limit);
            const cursor = offset + page.length < items.length ? rowKey({ addon: page[page.length - 1] }) : null;
            return parseBoundary({ schema: addonListSchema, input: { items: page, cursor } });
        } }, options),
        install: (input, options) => mutate({ ...input, operation: 'addons.install', run: () => performInstall({ ...input, dependencies: required }, options) }, options),
        setEnabled: (input, options) => mutate({ ...input, operation: 'addons.set_enabled', run: () => performSetEnabled({ ...input, dependencies: required }, options) }, options),
        uninstall: (input, options) => mutate({ ...input, operation: 'addons.uninstall', run: () => performUninstall({ ...input, dependencies: required }, options) }, options),
        describe: (input, options) => addonBoundary({ ...input, dependencies: required, operation: 'addons.describe', run: async () => {
            const addon = await findAddon({ ...input, repo: required.repo });
            if (!addon || !addon.enabled || addon.revision !== input.revision) return addonFailure({ code: 'conflict' });
            const value = await required.packages[input.kind].describe({ ...input, addon });
            // Instructions may await filesystem reads: recheck removal/disable after those awaits.
            const current = await findAddon({ ...input, repo: required.repo });
            if (!current?.enabled || current.revision !== input.revision) return addonFailure({ code: 'conflict' });
            return { ok: true, value };
        } }, options),
    };

    /** Instance-local guard prevents enable/install/uninstall races; read paths remain available. */
    function mutate<T>(input: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }, options?: CallOptions): Promise<Outcome<T>> {
        return addonBoundary({ ...input, dependencies: required, run: async () => {
            const key = JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId]);
            if (busy.has(key)) return addonFailure({ code: 'conflict' });
            busy.add(key);
            try { return await attempt({ run: input.run }); } finally { busy.delete(key); }
        } }, options);
    }
}

/** Replay validated upload digests before package preparation, which can reject existing version folders.
 * New versions retain Jini's validation/publication rules; only successful commits update the catalog.
 * @complexity O(upload bytes + paths log paths + catalog rows), bounded by upload/catalog limits.
 */
async function performInstall(required: { context: CallContext; request: InstallAddon; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    const parsed = parseBoundary({ schema: installAddonSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const decoded = await required.dependencies.decodeUpload({ upload: parsed.value.upload }, optional);
    if (!decoded.ok) return decoded;
    if (parsed.value.kind && parsed.value.kind !== decoded.value.kind) return addonFailure({ code: 'invalid_input' });
    const rows = await required.dependencies.repo.list(required);
    const replay = rows.find(row => row.kind === decoded.value.kind && row.revision === decoded.value.revision);
    if (replay) return { ok: true, value: replay };
    const backend = required.dependencies.packages[decoded.value.kind];
    const prepared = await backend.prepare({ context: required.context, ...decoded.value }).catch(() => undefined);
    if (!prepared) return addonFailure({ code: 'conflict' });
    const summary = parseBoundary({ schema: addonSummarySchema, input: { ...prepared.summary, enabled: false } });
    if (!summary.ok) return summary;
    if (summary.value.kind !== decoded.value.kind || summary.value.revision !== decoded.value.revision) return addonFailure({ code: 'conflict' });
    return publishInstall({ ...required, rows, prepared, addon: summary.value }, optional);
}

/** Audited publication uses the existing commit seam; replacement closes the prior runtime first.
 * @complexity O(n) catalog lookup, n <=1000; constant adapter calls and no new durable state.
 */
async function publishInstall(required: { context: CallContext; dependencies: AddonDependencies; rows: AddonSummary[]; prepared: PreparedAddon; addon: AddonSummary }, optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    const { prepared, addon } = required;
    const previous = required.rows.find(row => row.kind === addon.kind && row.id === addon.id);
    if (previous?.revision === addon.revision) return { ok: true, value: previous };
    if (!previous && required.rows.length >= 1000) return addonFailure({ code: 'limit_exceeded' });
    if (optional?.signal?.aborted) return addonFailure({ code: 'cancelled' });
    const operationId = required.dependencies.ids.next({});
    const audited = await required.dependencies.audit.record({ context: required.context, pluginId: addon.id, operationId, operation: 'install.requested' }, optional);
    if (!audited.ok) return audited;
    if (previous) {
        const retired = await closeIdle({ context: required.context, addon: previous, dependencies: required.dependencies }, optional);
        if (!retired.ok) return retired;
    }
    if (optional?.signal?.aborted) return addonFailure({ code: 'cancelled' });
    return attempt({ run: async () => {
        await prepared.commit({ previous });
        await required.dependencies.repo.save({ context: required.context, addon });
        const completed = await required.dependencies.audit.record({ context: required.context, pluginId: addon.id, operationId, operation: 'install.completed' }, optional);
        return completed.ok ? { ok: true, value: addon } : reconciliationFailure();
    } });
}

/** Audit precedes activation; disable closes runtime even when audit or persistence fails.
 * @complexity Constant adapter calls plus one bounded catalog read (<=1000 rows).
 */
async function performSetEnabled(required: { context: CallContext; request: SetAddonEnabled; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    const parsed = parseBoundary({ schema: setAddonEnabledSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const current = await findAddon({ context: required.context, ...parsed.value, repo: required.dependencies.repo });
    if (!current) return addonFailure({ code: 'invalid_input' });
    const operationId = required.dependencies.ids.next({});
    const audited = await required.dependencies.audit.record({ context: required.context, pluginId: current.id, operationId, operation: parsed.value.enabled ? 'enable.requested' : 'disable.requested' }, optional);
    if (!audited.ok && parsed.value.enabled) return audited;
    return attempt({ run: async () => {
        await closeRuntime({ ...required, addon: current });
        if (!audited.ok) return reconciliationFailure();
        if (optional?.signal?.aborted) return addonFailure({ code: 'cancelled' });
        if (!parsed.value.enabled) return { ok: true, value: { ...current, enabled: false } };
        return enableCurrent({ ...required, addon: current });
    } });
}

/** Publish enabled metadata last. Any partial enable or save failure unregisters again. */
async function enableCurrent(required: { context: CallContext; addon: AddonSummary; dependencies: AddonDependencies }): Promise<Outcome<AddonSummary>> {
    try {
        await required.dependencies.packages[required.addon.kind].setEnabled({ ...required, enabled: true });
        const addon = { ...required.addon, enabled: true };
        await required.dependencies.repo.save({ context: required.context, addon });
        return { ok: true, value: addon };
    } catch {
        await closeRuntime(required);
        return reconciliationFailure();
    }
}

/** Always attempt runtime cleanup, including when persisting closed metadata throws. */
async function closeRuntime(required: { context: CallContext; addon: AddonSummary; dependencies: AddonDependencies }): Promise<void> {
    const addon = { ...required.addon, enabled: false };
    try { await required.dependencies.repo.save({ context: required.context, addon }); }
    finally { await required.dependencies.packages[addon.kind].setEnabled({ context: required.context, addon, enabled: false }); }
}

/** Activity is checked on both sides of closing admission. A racing job retains bytes/metadata. */
async function closeIdle(required: { context: CallContext; addon: AddonSummary; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<void>> {
    const idle = await checkIdle(required, optional);
    if (!idle.ok) return idle;
    const closed = await attempt({ run: async () => { await closeRuntime(required); return { ok: true, value: undefined }; } });
    return closed.ok ? checkIdle(required, optional) : closed;
}

/** Invalid or unresolved activity never becomes permission to delete. */
async function checkIdle(required: { context: CallContext; addon: AddonSummary; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<void>> {
    const activity = await required.dependencies.runningJobs({ context: required.context, kind: required.addon.kind, id: required.addon.id }, optional);
    if (!activity.ok) return activity;
    if (!Number.isSafeInteger(activity.value) || activity.value < 0) return reconciliationFailure();
    return activity.value === 0 ? { ok: true, value: undefined } : addonFailure({ code: 'conflict' });
}

/** Audit, check activity, close admission, recheck activity, then remove bytes and metadata. */
async function performUninstall(required: { context: CallContext; request: UninstallAddon; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<AddonUninstallReceipt>> {
    const parsed = parseBoundary({ schema: uninstallAddonSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const addon = await findAddon({ context: required.context, ...parsed.value, repo: required.dependencies.repo });
    if (!addon) return parseBoundary({ schema: addonUninstallReceiptSchema, input: { ...parsed.value, removed: true } });
    const operationId = required.dependencies.ids.next({});
    const audited = await required.dependencies.audit.record({ context: required.context, pluginId: addon.id, operationId, operation: 'uninstall.requested' }, optional);
    if (!audited.ok) return audited;
    const closed = await closeIdle({ ...required, addon }, optional);
    if (!closed.ok) return closed;
    if (optional?.signal?.aborted) return addonFailure({ code: 'cancelled' });
    return attempt({ run: async () => {
        await required.dependencies.packages[addon.kind].remove({ context: required.context, addon });
        await required.dependencies.repo.remove({ context: required.context, ...parsed.value });
        const completed = await required.dependencies.audit.record({ context: required.context, pluginId: addon.id, operationId, operation: 'uninstall.completed' }, optional);
        return completed.ok ? parseBoundary({ schema: addonUninstallReceiptSchema, input: { ...parsed.value, removed: true } }) : reconciliationFailure();
    } });
}

async function findAddon(required: { context: CallContext; kind: AddonKind; id: string; repo: AddonRepository }): Promise<AddonSummary | undefined> {
    return (await required.repo.list(required)).find(row => row.kind === required.kind && row.id === required.id);
}

function rowKey(required: { addon: AddonSummary }): string {
    return required.addon.kind + ':' + createHash('sha256').update(required.addon.id).digest('hex');
}
/** Foreign Array.sort ABI: lexical order is stable across locale and restart. */
function compareAddons(left: AddonSummary, right: AddonSummary): number {
    const a = rowKey({ addon: left }); const b = rowKey({ addon: right });
    return a < b ? -1 : Number(a > b);
}

