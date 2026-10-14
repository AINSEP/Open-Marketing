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
import { jobsDatabase } from './forms.js';
import type { bindServerDatabase } from './database.js';
import { localFailure } from './local-auth.js';

/** Durable append-only audit with the existing conservative local reference redactor.
 * @complexity O(1) construction; SQL methods inherit bounded owning queries. */
export function bindCatalogAudit(required: { unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort }): AuditService {
    return createAuditService({ clock: required.clock, ids: required.ids, repo: createSqlAuditRepo({ ...required, db: {
        transaction: ({ execute }) => required.unit.transaction({ work: ({ session }) => execute({ session }) }),
    } }), redactor: createMemoryAuditRedactor({}) }, { observer: required.observer });
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
        jobs: createSqlScopedJobs({ database: jobsDatabase({ unit: required.database.unit }), clock: required.clock, observer: required.observer }),
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
