/** Feature instances for the one catalog. All persistence shares the boot-owned kernel. */
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createAuditService, createSqlAuditRepo, createMemoryAuditRedactor } from '@open-marketing/audit';
import type { AuditService } from '@open-marketing/audit';
import { createSqlWorkspaceRepo, createSqlWorkspaceListing } from '@open-marketing/workspaces';
import { createSqlScopedJobs } from '@open-marketing/jobs';
import { createSqlPaidSendingAllowances } from '@open-marketing/safety';
import type { SafetySqlDatabase } from '@open-marketing/safety';
import { createMeasureService } from '@open-marketing/measure';
import type { MeasureRepoPort, TrackedLinkPort, PlatformReportingPort } from '@open-marketing/measure';
import { digestArguments } from '@open-marketing/safety';
import type { bindServerDatabase } from './database.js';
import { localFailure } from './local-auth.js';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { idSchema, digestSchema } from '@open-marketing/contracts';
import { mimeForTransformFormat, preserveMediaCreator, MediaConflictError, MediaValidationError } from '@jini-ai/cms/media';
import { LocalFsBlobStore } from '@jini-ai/cms/media/node';
import { createHttpClient, createNodeGuardedHttpPorts } from '@jini-ai/platform/http/guarded';
import { createMediaLibrary, createSqlMediaRepo, createJiniMediaAdapter, createJiniBlobStore,
    createJiniGuardedAssetImport, createJiniImageTransform, createImageInspectionAdapter } from '@open-marketing/media-library';
import type { JiniMediaDependencies, JiniAssetImportDependencies, MediaLibrary } from '@open-marketing/media-library';
import type { CampaignSqlPort } from '@open-marketing/campaigns';

type MediaEffects = Pick<JiniMediaDependencies, 'blobStore' | 'imageTransformer'>
    & Pick<JiniAssetImportDependencies, 'httpClient' | 'outboundGuard'>
    & Pick<Parameters<typeof createImageInspectionAdapter>[0], 'decode'>;

/** Durable append-only audit with the existing conservative local reference redactor.
 * @complexity O(1) construction; SQL methods inherit bounded owning queries. */
export function bindCatalogAudit(required: { unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort }): AuditService {
    return createAuditService({ clock: required.clock, ids: required.ids, repo: createSqlAuditRepo({ ...required, db: required.unit }), redactor: createMemoryAuditRedactor({}) }, { observer: required.observer });
}
/** Lifecycle adapters record through the owning audit service; no second evidence store. */
export function catalogAuditPort(required: { audit: AuditService }) {
    return { async record(input: { context: CallContext; operationId: string; outcome: string }): Promise<Outcome<void>> {
        const digest = digestArguments({ arguments: { outcome: input.outcome } });
        if (!digest.ok) return digest;
        const recorded = await required.audit.record({ context: input.context, entry: { operationId: input.operationId,
            kind: 'outcome', argumentsDigest: digest.value, references: [] } });
        return recorded.ok ? { ok: true, value: undefined } : recorded;
    } };
}
/** Lookup never authenticates or binds accounts; authenticated ingress supplies its scope. */
export function bindCatalogScope(required: { database: ReturnType<typeof bindServerDatabase>; safetyDb: SafetySqlDatabase; clock: ClockPort; ids: IdPort; observer: ObserverPort; timezone: string }) {
    const repo = createSqlWorkspaceRepo({ db: required.database.workspace, ids: required.ids,
        identity: { async verify() { return localFailure({ code: 'forbidden', message: 'Session resolution is not a catalog capability' }); } } }, { observer: required.observer });
    return { accountBindings: repo, workspaces: createSqlWorkspaceListing({ db: required.database.workspace, observer: required.observer }),
        jobs: createSqlScopedJobs({ database: required.database.unit, clock: required.clock, observer: required.observer }),
        paidSending: createSqlPaidSendingAllowances({ db: required.safetyDb, clock: required.clock, observer: required.observer, timezone: required.timezone }) };
}
/** Explicit zero-spend sandbox report, never a fabricated live vendor observation. Account ID
 * must be sandbox-account. Real platform reports remain I-2. @complexity O(1), no egress. */
export function sandboxPlatformReports(required: { clock: ClockPort; ids: IdPort }): PlatformReportingPort {
    return { async snapshot({ query }) {
        if (query.accountId !== 'sandbox-account') return localFailure({ code: 'unavailable', message: 'I-2: connect a platform report backend; local reports use sandbox-account' });
        return { ok: true, value: { snapshotId: required.ids.next({}), accountId: query.accountId, window: query.window,
            spend: { currency: query.currency, minorUnits: 0 }, timezone: query.timezone, attributionWindow: query.attributionWindow, retrievedAt: required.clock.now({}) } };
    } };
}
/** Interactive measure reads/link creation reuse real storage. Verified ingestion and delivery
 * retain their existing local denial and are never catalog tools. */
export function bindCatalogMeasure(required: { repo: MeasureRepoPort; links: TrackedLinkPort; reports: PlatformReportingPort; clock: ClockPort; ids: IdPort; observer: ObserverPort; audit: AuditService }) {
    return createMeasureService({ ...required, audit: catalogAuditPort(required),
        policy: { async assess() { return { ok: true, value: { allowed: false } }; } },
        conversions: { async deliver() { return localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' }); } },
        jobs: { async enqueue() { return localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' }); } },
    }, { observer: required.observer });
}

/** Bind the public media service to scoped SQL/Jini records and explicit host effects.
 * No I/O occurs at construction. Failures stay with the media boundary and its observer.
 * @example bindCatalogMedia({ db, context, clock, ids, observer, audit, effects });
 * @complexity O(1) construction; canonical lists load at most 1,001 records.
 */
export function bindCatalogMedia(required: { db: CampaignSqlPort; context: CallContext; clock: ClockPort; ids: IdPort;
    observer: ObserverPort; audit: AuditService; effects: MediaEffects }): MediaLibrary {
    const scope = required.context.scope;
    const dependencies: JiniMediaDependencies = { ...required.effects, ...catalogMediaRepos(required),
        clock: { nowMs: () => required.clock.now({}) }, idGen: { newId: () => required.ids.next({}) } };
    const observed = { observer: required.observer };
    const inspection = createImageInspectionAdapter({ scope, decode: required.effects.decode }, observed);
    return createMediaLibrary({ clock: required.clock, ids: required.ids,
        repo: createSqlMediaRepo({ db: required.db, scope }, observed),
        media: createJiniMediaAdapter({ scope, dependencies }, observed),
        blobs: createJiniBlobStore({ scope, store: dependencies.blobStore }, observed),
        importer: createJiniGuardedAssetImport({ ...required.effects, scope, dependencies, inspection }, { ...observed, maxBytes: 10000000, timeoutMs: 20000 }),
        transforms: createJiniImageTransform({ scope, dependencies }, { ...observed, inspection }),
        audit: { record: input => catalogAuditPort(required).record({ ...input, outcome: 'media:' + input.assetId }) },
    }, observed);
}

const mediaIso = z.iso.datetime({ offset: true });
const mediaRecord = z.strictObject({ id: idSchema, workspaceId: idSchema, createdBy: idSchema.nullable().optional(),
    title: z.string().max(2048), slug: z.string().min(1).max(256), alt: z.string().max(4096), caption: z.string().max(16000), credit: z.string().max(4096),
    source: z.strictObject({ sha256: digestSchema }), status: z.enum(['active', 'trashed']), createdAt: mediaIso, updatedAt: mediaIso,
    version: z.number().int().positive(), width: z.number().int().positive().max(8000).nullable(), height: z.number().int().positive().max(8000).nullable(),
    cssClass: z.string().max(2048).nullable(), htmlAttributes: z.string().max(4096).nullable() });
const mediaBlob = z.strictObject({ id: idSchema, workspaceId: idSchema, sha256: digestSchema, storageKey: z.string().max(1024),
    createdByPrincipal: idSchema, createdAt: mediaIso, status: z.enum(['active', 'tombstoned']), tombstonedAt: mediaIso.optional() });
const mediaRendition = z.strictObject({ id: idSchema, workspaceId: idSchema, assetId: idSchema, transformName: idSchema,
    version: z.number().int().positive(), storageKey: z.string().max(1024), createdAt: mediaIso });
const mediaTransform = z.strictObject({ id: idSchema, workspaceId: idSchema, name: idSchema, version: z.number().int().positive(),
    params: z.strictObject({ width: z.number().int().positive().max(8000).optional(), height: z.number().int().positive().max(8000).optional(),
        fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).optional(), format: z.enum(['jpeg', 'png', 'webp', 'gif']), quality: z.number().int().min(1).max(100).optional() }),
    owner: idSchema, createdAt: mediaIso });
type MediaKind = 'media' | 'blob' | 'rendition' | 'transform';
type MediaSql = { db: CampaignSqlPort; context: CallContext };

/** Host persistence for Jini's four public repository ABIs; no parallel domain services.
 * Save callbacks use Jini's record ABI. The SQL helper validates every stored payload.
 * @complexity Indexed key reads; list queries cap materialization at 1,001 rows.
 */
function catalogMediaRepos(required: MediaSql): Pick<JiniMediaDependencies, 'mediaRepo' | 'blobRepo' | 'renditionRepo' | 'transformRepo'> {
    const read = <T>(input: { kind: MediaKind; workspaceId: string; schema: z.ZodType<T>; where?: string; values?: unknown[] }) => readMediaRows({ ...required, ...input });
    return {
        mediaRepo: {
            async findById(input) { return (await read({ ...input, kind: 'media', schema: mediaRecord, where: 'AND record_key=$4', values: [input.id] }))[0] ?? null; },
            async findBySlug(input) { return (await read({ ...input, kind: 'media', schema: mediaRecord, where: "AND json_extract(payload,'$.slug')=$4", values: [input.slug] }))[0] ?? null; },
            list: input => read({ ...input, kind: 'media', schema: mediaRecord }),
            async save(record) {
                const previous = (await read({ kind: 'media', workspaceId: record.workspaceId, schema: mediaRecord, where: 'AND record_key=$4', values: [record.id] }))[0];
                if (previous && previous.source.sha256 !== record.source.sha256) throw new MediaConflictError({ message: 'Media source is immutable' });
                const next = previous ? preserveMediaCreator({ record, original: previous }) : record;
                await saveMediaRow({ ...required, kind: 'media', key: record.id, record: mediaRecord.parse(next) });
            },
            remove: input => removeMediaRows({ ...required, ...input, kind: 'media', where: 'AND record_key=$4', values: [input.id] }),
        },
        blobRepo: {
            async findByHash(input) { return (await read({ ...input, kind: 'blob', schema: mediaBlob, where: 'AND record_key=$4', values: [input.sha256] }))[0] ?? null; },
            list: input => read({ ...input, kind: 'blob', schema: mediaBlob }),
            save: record => saveMediaRow({ ...required, kind: 'blob', key: record.sha256, record: mediaBlob.parse(record) }),
            remove: input => removeMediaRows({ ...required, ...input, kind: 'blob', where: 'AND record_key=$4', values: [input.sha256] }),
        },
        renditionRepo: {
            listByAsset: input => read({ ...input, kind: 'rendition', schema: mediaRendition, where: "AND json_extract(payload,'$.assetId')=$4", values: [input.assetId] }),
            async findOne(input) { return (await read({ ...input, kind: 'rendition', schema: mediaRendition, where: 'AND record_key=$4', values: [JSON.stringify([input.assetId, input.transformName, input.version])] }))[0] ?? null; },
            save: record => saveMediaRow({ ...required, kind: 'rendition', key: JSON.stringify([record.assetId, record.transformName, record.version]), record: mediaRendition.parse(record) }),
            removeByAsset: input => removeMediaRows({ ...required, ...input, kind: 'rendition', where: "AND json_extract(payload,'$.assetId')=$4", values: [input.assetId] }),
        },
        transformRepo: {
            listByName: input => read({ ...input, kind: 'transform', schema: mediaTransform, where: "AND json_extract(payload,'$.name')=$4", values: [input.name] }),
            async findByNameVersion(input) { return (await read({ ...input, kind: 'transform', schema: mediaTransform, where: 'AND record_key=$4', values: [JSON.stringify([input.name, input.version])] }))[0] ?? null; },
            insert: record => saveMediaRow({ ...required, kind: 'transform', key: JSON.stringify([record.name, record.version]), record: mediaTransform.parse(record) }),
        },
    };
}

/** Only fixed local SQL fragments reach this helper; no tool/model input is interpolated.
 * @throws On invalid stored JSON, foreign scope or a collection exceeding 1,000 records.
 * @complexity O(n) decoding with n <=1,001; no per-row I/O.
 */
async function readMediaRows<T>(required: MediaSql & { kind: MediaKind; workspaceId: string; schema: z.ZodType<T>; where?: string; values?: unknown[] }): Promise<T[]> {
    checkMediaWorkspace(required);
    const result = await required.db.query({ text: `SELECT payload FROM server_media_record WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 ${required.where ?? ''} ORDER BY record_key LIMIT 1001`,
        values: [required.context.scope.ownerId, required.workspaceId, required.kind, ...required.values ?? []] });
    if (result.rows.length > 1000) throw new MediaValidationError({ message: 'Media repository collection limit exceeded' });
    return result.rows.map(row => required.schema.parse(JSON.parse(z.string().max(100000).parse(row.payload))));
}
function checkMediaWorkspace(required: { context: CallContext; workspaceId: string }): void {
    if (required.workspaceId !== required.context.scope.workspaceId) throw new MediaValidationError({ message: 'Media workspace differs from binding' });
}
/** Canonical records support Jini save semantics; transform identities are append-only in SQL.
 * @complexity O(1) indexed upsert. SQL errors propagate to the owning typed media boundary.
 */
async function saveMediaRow(required: MediaSql & { kind: MediaKind; key: string; record: { workspaceId: string } }): Promise<void> {
    checkMediaWorkspace({ ...required, workspaceId: required.record.workspaceId });
    const conflict = required.kind === 'transform' ? '' : 'ON CONFLICT(owner_id,workspace_id,kind,record_key) DO UPDATE SET payload=excluded.payload';
    await required.db.query({ text: `INSERT INTO server_media_record(owner_id,workspace_id,kind,record_key,payload) VALUES($1,$2,$3,$4,$5) ${conflict}`,
        values: [required.context.scope.ownerId, required.record.workspaceId, required.kind, required.key, JSON.stringify(required.record)] });
}
/** Jini upload compensation removes only canonical metadata; shared blobs are retained by its owner. */
async function removeMediaRows(required: MediaSql & { kind: Exclude<MediaKind, 'transform'>; workspaceId: string; where: string; values: unknown[] }): Promise<void> {
    checkMediaWorkspace(required);
    await required.db.query({ text: `DELETE FROM server_media_record WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 ${required.where}`,
        values: [required.context.scope.ownerId, required.workspaceId, required.kind, ...required.values] });
}

/** Native adapters are constructed only by boot. Codec loading is lazy and absence fails closed.
 * HTTPS ingress pins every resolved peer and redirect; encoded/decoded HTTP bytes cap at 10 MB.
 * @example createCatalogMediaEffects({ stateRoot, clock });
 * @complexity O(1) construction, no file/network/codec I/O until invocation.
 */
export function createCatalogMediaEffects(required: { stateRoot: string; clock: ClockPort }): MediaEffects {
    const ports = createNodeGuardedHttpPorts({});
    const httpClient = createHttpClient({ ...ports, clock: { ...ports.clock, nowMs: () => required.clock.now({}) }, userAgent: 'Open-Marketing',
        policy: { allowedSchemes: ['https'], denyPrivateAddresses: true, devHostAllowlist: [], maxRedirects: 3,
            connectTimeoutMs: 10000, maxResponseBytes: 10000000, maxDecompressedBytes: 10000000 } });
    return { blobStore: new LocalFsBlobStore({ rootDir: join(required.stateRoot, 'media') }), httpClient,
        outboundGuard: { send: ({ request }) => httpClient.send({ request }) }, decode: inspectCatalogImage,
        imageTransformer: { async transform({ bytes, params }) {
            const pipeline = catalogImagePipeline({ bytes, maxPixels: 40000000 });
            try {
                const output = await pipeline.resize({ width: params.width, height: params.height, fit: params.fit })
                    .toFormat(params.format, { quality: params.quality }).toBuffer();
                return { bytes: output, contentType: mimeForTransformFormat({ format: params.format }) };
            } finally { pipeline.destroy(); }
        } } };
}

// Narrow ABI for the optional codec peer; no dependency change or fallback to a fake transform.
interface CatalogImagePipeline {
    metadata(): Promise<unknown>; stats(): Promise<unknown>;
    timeout(required: { seconds: number }): CatalogImagePipeline;
    resize(required: { width?: number; height?: number; fit?: string }): CatalogImagePipeline;
    toFormat(format: string, options: { quality?: number }): CatalogImagePipeline;
    toBuffer(): Promise<Uint8Array>; destroy(): void;
}
/** Jini's Sharp adapter has no pixel/deadline options; configure its optional codec peer here. */
function catalogImagePipeline(required: { bytes: Uint8Array; maxPixels: number }): CatalogImagePipeline {
    const require = createRequire(import.meta.url);
    const sharp = createRequire(require.resolve('@jini-ai/cms/media/node'))('sharp') as
        (bytes: Uint8Array, options: { limitInputPixels: number; failOn: string }) => CatalogImagePipeline;
    return sharp(required.bytes, { limitInputPixels: required.maxPixels, failOn: 'warning' }).timeout({ seconds: 10 });
}
/** Full bounded decode before any import write. Metadata alone is not evidence of valid pixels.
 * Abort destroys the pipeline; the native codec timeout also bounds work after cancellation.
 * @complexity O(decoded pixels), <=40 million pixels, one frame, ten seconds.
 */
async function inspectCatalogImage(required: Parameters<MediaEffects['decode']>[0], optional?: Parameters<MediaEffects['decode']>[1]): Promise<unknown> {
    const pipeline = catalogImagePipeline(required);
    const abort = () => pipeline.destroy();
    optional?.signal?.addEventListener('abort', abort, { once: true });
    try {
        optional?.signal?.throwIfAborted();
        const metadata = z.object({ width: z.number().int().positive().max(8000), height: z.number().int().positive().max(8000),
            pages: z.number().int().min(1).max(1).optional() }).parse(await pipeline.metadata());
        if (metadata.width * metadata.height > required.maxPixels) throw new MediaValidationError({ message: 'Image pixel limit exceeded' });
        await pipeline.stats();
        return { width: metadata.width, height: metadata.height, frames: metadata.pages ?? 1 };
    } finally { optional?.signal?.removeEventListener('abort', abort); pipeline.destroy(); }
}
