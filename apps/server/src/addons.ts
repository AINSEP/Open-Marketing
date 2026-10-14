/** Server add-on lifecycle. Jini owns package semantics; SQLite owns the exposed activation/revision. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { addonListRequestSchema, addonListSchema, addonSummarySchema, addonUninstallReceiptSchema,
    appErrorSchema, callContextSchema, installAddonSchema, parseBoundary, setAddonEnabledSchema, uninstallAddonSchema } from '@open-marketing/contracts';
import type { AddonKind, AddonList, AddonSummary, AddonUninstallReceipt, AppError, CallContext, CallOptions,
    InstallAddon, ObserverPort, Outcome, SetAddonEnabled, UninstallAddon } from '@open-marketing/contracts';
import type { ArchiveReaderPort } from '@jini-ai/agentic/skills/install';
import type { AddonFiles } from './addon-upload.js';
import { decodeAddonUpload } from './addon-upload.js';
import type { CredentialSqlPort } from '@open-marketing/credentials';

/** Prepared bytes cannot change between inspection and commit. Discovery reads no full instructions. */
export type PreparedAddon = { summary: AddonSummary; commit(): Promise<void> };
export type AddonDescription = { effects?: unknown; instructions?: string; skills?: readonly { name: string; description: string }[];
    tools?: readonly { name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; effects?: unknown }[] };
/** The three concrete Jini adapters and fixture double implement this small, current-use boundary. */
export interface AddonPackageAdapter {
    prepare(required: { context: CallContext; files: AddonFiles; revision: string }): Promise<PreparedAddon>;
    setEnabled(required: { context: CallContext; addon: AddonSummary; enabled: boolean }): Promise<void>;
    remove(required: { context: CallContext; addon: AddonSummary }): Promise<void>;
    describe(required: { context: CallContext; addon: AddonSummary; skill?: string }): Promise<AddonDescription>;
}
export interface AddonRepository {
    list(required: { context: CallContext }): Promise<AddonSummary[]>;
    save(required: { context: CallContext; addon: AddonSummary }): Promise<void>;
    remove(required: { context: CallContext; kind: AddonKind; id: string }): Promise<void>;
}
export interface AddonDependencies {
    repo: AddonRepository; packages: Record<AddonKind, AddonPackageAdapter>; archiveReader: ArchiveReaderPort; observer: ObserverPort;
}
export interface Addons {
    list(required: { context: CallContext; query: { limit: number; cursor?: string; kind?: AddonKind } }, optional?: CallOptions): Promise<Outcome<AddonList>>;
    install(required: { context: CallContext; request: InstallAddon }, optional?: CallOptions): Promise<Outcome<AddonSummary>>;
    setEnabled(required: { context: CallContext; request: SetAddonEnabled }, optional?: CallOptions): Promise<Outcome<AddonSummary>>;
    uninstall(required: { context: CallContext; request: UninstallAddon }, optional?: CallOptions): Promise<Outcome<AddonUninstallReceipt>>;
    describe(required: { context: CallContext; kind: AddonKind; id: string; revision: string; skill?: string }, optional?: CallOptions): Promise<Outcome<AddonDescription>>;
}

/** Inert binding. Scope mutation overlap is refused, without another queue or outbox.
 * Every failed enable persists closed state and unregisters runtime resources before returning.
 * @example const addons = createAddons({ repo, packages, archiveReader, observer });
 * @complexity <=1000 retained summaries per scope; upload <=32 MiB. No vendor calls.
 */
export function createAddons(required: AddonDependencies): Addons {
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
            const key = JSON.stringify(input.context.scope);
            if (busy.has(key)) return addonFailure({ code: 'conflict' });
            busy.add(key);
            try { return await input.run(); } finally { busy.delete(key); }
        } }, options);
    }
}

/** Same bytes replay preserves activation; executable plugins may install a different version.
 * Other differing bytes for the same id require uninstall first.
 * No package commit occurs for duplicates/conflicts. Installation never publishes an active source.
 * @example await installAddon({ context, request, dependencies });
 * @complexity Bounded decoding and catalog scan (<=1000 rows); new bytes also use package inspection and save.
 */
export async function installAddon(required: { context: CallContext; request: InstallAddon; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    return addonBoundary({ ...required, operation: 'addons.install', run: () => performInstall(required, optional) }, optional);
}

/** Replay validated upload digests before package preparation, which can reject existing version folders.
 * New versions retain Jini's validation/publication rules; only successful commits update the catalog.
 * @complexity O(upload bytes + paths log paths + catalog rows), bounded by upload/catalog limits.
 */
async function performInstall(required: Parameters<typeof installAddon>[0], optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    const parsed = parseBoundary({ schema: installAddonSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const decoded = await decodeAddonUpload({ upload: parsed.value.upload, archiveReader: required.dependencies.archiveReader }, optional);
    if (!decoded.ok) return decoded;
    if (parsed.value.kind && parsed.value.kind !== decoded.value.kind) return addonFailure({ code: 'invalid_input' });
    const rows = await required.dependencies.repo.list(required);
    const replay = rows.find(row => row.kind === decoded.value.kind && row.revision === decoded.value.revision);
    if (replay) return { ok: true, value: replay };
    const backend = required.dependencies.packages[decoded.value.kind];
    const prepared = await backend.prepare({ context: required.context, ...decoded.value });
    const summary = parseBoundary({ schema: addonSummarySchema, input: { ...prepared.summary, enabled: false } });
    if (!summary.ok) return summary;
    const previous = rows.find(row => row.kind === summary.value.kind && row.id === summary.value.id
        && (row.kind !== 'plugin' || row.version === summary.value.version));
    if (previous) return replayOutcome({ previous, revision: summary.value.revision });
    if (rows.length >= 1000) return addonFailure({ code: 'limit_exceeded' });
    if (optional?.signal?.aborted) return addonFailure({ code: 'cancelled' });
    await prepared.commit();
    await required.dependencies.repo.save({ context: required.context, addon: summary.value });
    return { ok: true, value: summary.value };
}

function replayOutcome(required: { previous: AddonSummary; revision: string }): Outcome<AddonSummary> {
    return required.previous.revision === required.revision ? { ok: true, value: required.previous } : addonFailure({ code: 'conflict' });
}

/** Persist disabled before runtime changes. Enable failures dispose and never expose a source.
 * @example await setAddonEnabled({ context, request: { kind, id, enabled: true }, dependencies });
 */
export async function setAddonEnabled(required: { context: CallContext; request: SetAddonEnabled; dependencies: AddonDependencies }, _optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    return addonBoundary({ ...required, operation: 'addons.set_enabled', run: () => performSetEnabled(required, _optional) }, _optional);
}

async function performSetEnabled(required: Parameters<typeof setAddonEnabled>[0], _optional?: CallOptions): Promise<Outcome<AddonSummary>> {
    const parsed = parseBoundary({ schema: setAddonEnabledSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const current = await findAddon({ context: required.context, ...parsed.value, repo: required.dependencies.repo });
    if (!current) return addonFailure({ code: 'invalid_input' });
    const disabled = { ...current, enabled: false };
    const backend = required.dependencies.packages[current.kind];
    try {
        await required.dependencies.repo.save({ context: required.context, addon: disabled });
        await backend.setEnabled({ context: required.context, addon: current, enabled: parsed.value.enabled });
        const addon = { ...current, enabled: parsed.value.enabled };
        await required.dependencies.repo.save({ context: required.context, addon });
        return { ok: true, value: addon };
    } catch {
        await backend.setEnabled({ context: required.context, addon: disabled, enabled: false });
        return addonFailure({ code: 'unavailable' });
    }
}

/** Disable and close sessions before byte removal; no nonexistent job-idle lookup.
 * A later dispatch reaches the current source check and fails explicitly.
 * @example await uninstallAddon({ context, request: { kind, id }, dependencies });
 */
export async function uninstallAddon(required: { context: CallContext; request: UninstallAddon; dependencies: AddonDependencies }, optional?: CallOptions): Promise<Outcome<AddonUninstallReceipt>> {
    return addonBoundary({ ...required, operation: 'addons.uninstall', run: () => performUninstall(required, optional) }, optional);
}

async function performUninstall(required: Parameters<typeof uninstallAddon>[0], optional?: CallOptions): Promise<Outcome<AddonUninstallReceipt>> {
    const parsed = parseBoundary({ schema: uninstallAddonSchema, input: required.request });
    if (!parsed.ok) return parsed;
    const disabled = await performSetEnabled({ ...required, request: { ...parsed.value, enabled: false } }, optional);
    if (!disabled.ok) return disabled;
    await required.dependencies.packages[disabled.value.kind].remove({ context: required.context, addon: disabled.value });
    await required.dependencies.repo.remove({ context: required.context, ...parsed.value });
    return parseBoundary({ schema: addonUninstallReceiptSchema, input: { ...parsed.value, removed: true } });
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

/** Fixed-scope SQL repository. Parameterized statements never persist paths, config or credentials.
 * @example const repo = createSqlAddonRepository({ db });
 * @complexity <=1000 summaries; the 1001st persisted row refuses reads rather than truncating.
 */
export function createSqlAddonRepository(required: { db: CredentialSqlPort }): AddonRepository {
    return {
        async list(input) {
            const rows = await required.db.query({ text: 'SELECT summary FROM addon_package WHERE owner_id=$1 AND workspace_id=$2 ORDER BY kind, addon_id LIMIT 1001', values: [input.context.scope.ownerId, input.context.scope.workspaceId] });
            if (rows.rows.length > 1000) throw new RangeError('Addon catalog limit');
            return rows.rows.map(row => addonSummarySchema.parse(JSON.parse(z.string().max(16384).parse(row.summary))));
        },
        async save(input) {
            const addon = addonSummarySchema.parse(input.addon);
            await required.db.query({ text: 'INSERT INTO addon_package (owner_id,workspace_id,kind,addon_id,summary) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(owner_id,workspace_id,kind,addon_id) DO UPDATE SET summary=excluded.summary',
                values: [input.context.scope.ownerId, input.context.scope.workspaceId, addon.kind, addon.id, JSON.stringify(addon)] });
        },
        async remove(input) {
            await required.db.query({ text: 'DELETE FROM addon_package WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 AND addon_id=$4', values: [input.context.scope.ownerId, input.context.scope.workspaceId, input.kind, input.id] });
        },
    };
}

/** Runs the injected operation with validated context and optional cancellation, then observes its outcome.
 * Valid structured failures retain their message and retry authority; throws become redacted unavailable errors.
 * No request bytes, plugin exceptions or secrets reach telemetry.
 * @example const result = await addonBoundary({ context, dependencies: { observer }, operation, run });
 * @complexity O(1) boundary time/space for fixed-shape validation; excludes the injected operation.
 */
export async function addonBoundary<T>(required: { context: CallContext; dependencies: Pick<AddonDependencies, 'observer'>; operation: string; run: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
    let result: Outcome<T>;
    try {
        const parsed = callContextSchema.safeParse(required.context);
        if (!parsed.success) result = addonFailure({ code: 'invalid_input' });
        else if (optional?.signal?.aborted) result = addonFailure({ code: 'cancelled' });
        else result = await required.run();
    } catch { result = addonFailure({ code: 'unavailable' }); }
    if (!result.ok) {
        const error = appErrorSchema.safeParse(result.error);
        result = error.success ? { ok: false, error: error.data } : addonFailure({ code: 'unavailable' });
    }
    try { required.dependencies.observer.observe({ operation: required.operation, outcome: result.ok ? 'succeeded' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
    catch { /* Observation cannot change committed activation. */ }
    return result;
}

/** Stable error values redact plugin/library errors and keep retries explicit. */
export function addonFailure(required: { code: AppError['code'] }): { ok: false; error: AppError } {
    return { ok: false, error: { code: required.code, message: 'Add-on operation unavailable or denied', retryable: required.code === 'unavailable' } };
}
