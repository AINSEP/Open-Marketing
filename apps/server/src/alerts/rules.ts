/** Server-local alert decisions. Reporting supplies normalized evidence; no vendor I/O. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { campaignKeySchema, campaignStatusOutputSchema, epochSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { AppError, CampaignKey, CampaignStatusOutput, Outcome } from '@open-marketing/contracts';
import { campaignResultsQuerySchema, campaignResultsSchema, type CampaignResults, type MetricDay } from '@open-marketing/measure';

/** Typed boundary failure; SQL/tainted payload details never escape. O(1). */
export function alertFailure(required: { code: AppError['code']; message: string }): Outcome<never> {
    return { ok: false, error: { ...required, retryable: required.code === 'unavailable' } };
}

const micros = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const spend = z.strictObject({ micros, currency, complete: z.boolean() });
const dailyBudget = z.strictObject({ kind: z.literal('daily'), currency, dailyMicros: micros, elapsedMonthMicros: micros.nullable() });
const lifetimeBudget = z.strictObject({ kind: z.literal('lifetime'), currency, totalMicros: micros,
    elapsedMicros: micros.nullable(), flightStart: epochSchema, flightEnd: epochSchema })
    .refine(value => value.flightStart < value.flightEnd);
/** The caller must attest current budget history and complete reporting coverage.
 * Elapsed allocations come from reporting, never daily-budget multiplication here. */
export const pacingEvidenceSchema = z.strictObject({
    campaign: campaignKeySchema, localDay: z.iso.date(), timezone: idSchema, budgetCurrent: z.boolean(),
    budget: z.discriminatedUnion('kind', [dailyBudget, lifetimeBudget]),
    today: spend.nullable(), month: spend.nullable(), lifetime: spend.nullable(),
});
export type PacingEvidence = z.infer<typeof pacingEvidenceSchema>;
const statusBatch = campaignStatusOutputSchema.extend({ pluginId: idSchema, accountId: idSchema });
/** One bounded evidence page. Sources must continue paging rather than silently truncate. */
export const alertEvidenceSchema = z.strictObject({
    pendingCards: z.array(z.strictObject({ cardId: idSchema, status: z.enum(['pending', 'answered', 'expired']), expiresAt: epochSchema })).max(100),
    statuses: z.array(statusBatch).max(100).refine(batches => batches.reduce((count, batch) => count + batch.campaigns.length, 0) <= 100),
    pacing: z.array(pacingEvidenceSchema).max(100),
});
export type AlertEvidence = z.infer<typeof alertEvidenceSchema>;
/** Stored weekly evidence reuses result rows, including source labels and missingness.
 * Three rows leave room for seven observations and maximally JSON-escaped 256-character IDs. */
export const weeklyReportSchema = z.strictObject({
    target: campaignResultsQuerySchema.pick({ pluginId: true, connectionId: true, accountId: true }),
    days: campaignResultsQuerySchema.shape.days,
    currency: campaignResultsSchema.shape.currency, timezone: campaignResultsSchema.shape.timezone,
    complete: campaignResultsSchema.shape.complete, missingDays: campaignResultsSchema.shape.missingDays,
    observations: campaignResultsSchema.shape.observations,
    campaigns: z.array(campaignResultsSchema.shape.campaigns.element).max(3),
    omittedCampaigns: z.number().int().nonnegative(),
    /** Workspace-wide unattributed enquiries for the same days; absent on notices stored before it existed. */
    workspaceUnattributed: campaignResultsSchema.shape.workspaceUnattributed.optional(),
});
export type WeeklyReport = z.infer<typeof weeklyReportSchema>;
export const alertCandidateSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('approval_waiting'), dedupKey: idSchema, cardId: idSchema }),
    z.strictObject({ kind: z.literal('ad_disapproved'), dedupKey: idSchema, campaign: campaignKeySchema,
        reasons: z.array(z.string().min(1).max(1000)).max(20) }),
    z.strictObject({ kind: z.literal('pacing'), dedupKey: idSchema, campaign: campaignKeySchema, localDay: z.iso.date(),
        rules: z.array(z.enum(['today', 'month', 'lifetime'])).min(1).max(2) }),
    z.strictObject({ kind: z.literal('weekly_report'), dedupKey: idSchema, report: weeklyReportSchema }),
]).refine(candidate => new TextEncoder().encode(JSON.stringify(candidate)).length <= 32768);
export type AlertCandidate = z.infer<typeof alertCandidateSchema>;

/** Canonical local dedup identity, with bounded output regardless of vendor ID length. */
function fingerprint({ parts }: { parts: unknown[] }): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
/** Pure bounded snapshot; never adds platform conversions to OM leads or recomputes ratios.
 * Returns invalid_input for malformed/oversized evidence. Inputs remain unchanged.
 * @example weeklyReportCandidate({ target, days, results })
 * @complexity O(n log n) time/O(n) space, <=5,000 rows, no I/O.
 */
export function weeklyReportCandidate(required: { target: WeeklyReport['target']; days: WeeklyReport['days']; results: CampaignResults }): Outcome<AlertCandidate> {
    const parsed = parseBoundary({ schema: campaignResultsSchema, input: required.results });
    if (!parsed.ok) return parsed;
    const { currency, timezone, complete, missingDays, observations, workspaceUnattributed } = parsed.value;
    // Array.sort's foreign two-positional-argument ABI; unavailable and unsupported spend both sort last.
    const campaigns = [...parsed.value.campaigns].sort((left, right) => {
        const a = BigInt(left.metrics.spend ?? '-1'), b = BigInt(right.metrics.spend ?? '-1');
        if (a !== b) return a > b ? -1 : 1;
        return left.campaign.vendorCampaignId < right.campaign.vendorCampaignId ? -1 : left.campaign.vendorCampaignId > right.campaign.vendorCampaignId ? 1 : 0;
    });
    return parseBoundary({ schema: alertCandidateSchema, input: { kind: 'weekly_report',
        dedupKey: fingerprint({ parts: ['weekly', required.target, required.days] }),
        report: { target: required.target, days: required.days, currency, timezone, complete, missingDays, observations,
            campaigns: campaigns.slice(0, 3), omittedCampaigns: Math.max(0, campaigns.length - 3), workspaceUnattributed } } });
}
/** Compare only explicit complete spend in the budget's currency. O(1). */
function comparable(required: { spend: z.infer<typeof spend> | null; currency: string }): boolean {
    return required.spend !== null && required.spend.complete && required.spend.currency === required.currency;
}
/** Account-local date from the injected instant; invalid timezones return null. O(1), no I/O.
 * @example accountLocalDay({ timezone: 'UTC', now: 0 }) // '1970-01-01'
 */
export function accountLocalDay(required: { timezone: string; now: number }): string | null {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: required.timezone,
            year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(required.now));
        const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${fields.year}-${fields.month}-${fields.day}`;
    } catch { return null; }
}

/** Compare the evidence day using the same account-local date calculation. O(1). */
function localDayMatches(required: { evidence: PacingEvidence; now: number }): boolean {
    return accountLocalDay({ timezone: required.evidence.timezone, now: required.now }) === required.evidence.localDay;
}

// Two evaluation intervals: a refresh from the previous slot must survive dispatch jitter.
const PACING_MAX_AGE_MS = 30 * 60 * 1000;

/** Select today's fresh stored partition; absent rows/spend stay unknown.
 * @complexity O(partitions + rows), <=2 days and <=5,000 stored campaign rows; no I/O.
 */
function todayCampaignSpend(required: { campaign: CampaignKey; partitions: readonly MetricDay[]; now: number }) {
    const partition = required.partitions.find(({ day, batch }) => day === accountLocalDay({ timezone: batch.timezone, now: required.now })
        && batch.freshness === 'fresh' && batch.retrievedAt >= required.now - PACING_MAX_AGE_MS && batch.retrievedAt <= required.now);
    if (!partition) return null;
    const row = partition.batch.rows.find(row => row.entity.grain === 'campaign' && row.entity.vendorCampaignId === required.campaign.vendorCampaignId);
    if (typeof row?.metrics.spend !== 'string') return null;
    return { partition, micros: row.metrics.spend };
}

/** Project a current daily budget and fresh stored today spend; schema overflow means unknown.
 * History is not attested here, so month/lifetime remain null. No input mutation or I/O.
 * @example dailyPacingEvidence({ campaign, observation, observedAt, partitions, now })
 * @complexity O(partitions + rows) time/O(1) space; bounded stored partitions, exact money strings.
 */
export function dailyPacingEvidence(required: { campaign: CampaignKey; observation: CampaignStatusOutput['campaigns'][number];
    observedAt: number; partitions: readonly MetricDay[]; now: number }): PacingEvidence | null {
    const budget = required.observation.currentBudget;
    if (budget?.kind !== 'daily' || required.observedAt > required.now) return null;
    const selected = todayCampaignSpend(required);
    if (!selected) return null;
    const { partition: { day, batch }, micros: spendMicros } = selected;
    const parsed = pacingEvidenceSchema.safeParse({ campaign: required.campaign, localDay: day, timezone: batch.timezone, budgetCurrent: true,
        budget: { kind: 'daily', currency: budget.currency, dailyMicros: budget.amountMicros, elapsedMonthMicros: null },
        today: { micros: spendMicros, currency: batch.currency, complete: batch.complete }, month: null, lifetime: null });
    return parsed.success ? parsed.data : null;
}
/** Flight history is read through at most ten 31-day pages; older flights stay unknown. */
export const LIFETIME_HISTORY_DAYS = 310;
const DAY_MS = 86400000;

/** Calendar-date arithmetic on ISO dates; local dates carry no instant. O(1).
 * @example shiftDay({ day: '2026-10-01', days: 31 }) // '2026-11-01'
 */
export function shiftDay(required: { day: string; days: number }): string {
    return new Date(Date.parse(required.day) + required.days * DAY_MS).toISOString().slice(0, 10);
}
/** A stored history day counts only when complete and its exclusive data cutoff reaches the
 * next account-local day; dataThrough 0 (unknown) never qualifies. O(1), no I/O. */
export function historyDayCovered(required: { partition: MetricDay }): boolean {
    const { day, batch } = required.partition;
    return batch.complete && (accountLocalDay({ timezone: batch.timezone, now: batch.dataThrough }) ?? '') > day;
}
/** One covered day's explicit campaign spend in the reference batch's currency/timezone. O(rows). */
function historyDaySpend(required: { campaign: CampaignKey; partitions: readonly MetricDay[]; reference: MetricDay['batch']; day: string }): bigint | null {
    const partition = required.partitions.find(item => item.day === required.day);
    if (!partition || !historyDayCovered({ partition })) return null;
    if (partition.batch.timezone !== required.reference.timezone || partition.batch.currency !== required.reference.currency) return null;
    const row = partition.batch.rows.find(item => item.entity.grain === 'campaign' && item.entity.vendorCampaignId === required.campaign.vendorCampaignId);
    return typeof row?.metrics.spend === 'string' ? BigInt(row.metrics.spend) : null;
}
/** Sum every completed flight day before today; any missing day or row means unknown.
 * @complexity O(days * (partitions + rows)), <=310 days; exact bigint micros. */
function flightHistorySpend(required: { campaign: CampaignKey; partitions: readonly MetricDay[]; reference: MetricDay['batch']; flightStart: number; today: string }): bigint | null {
    const first = accountLocalDay({ timezone: required.reference.timezone, now: required.flightStart });
    if (first === null || first > required.today || first < shiftDay({ day: required.today, days: -LIFETIME_HISTORY_DAYS })) return null;
    let total = 0n;
    for (let day = first; day < required.today; day = shiftDay({ day, days: 1 })) {
        const spent = historyDaySpend({ ...required, day });
        if (spent === null) return null;
        total += spent;
    }
    return total;
}
/** Project a current lifetime budget from complete flight-to-date stored spend; unknown stays null.
 * Every account-local flight day before today needs a covered partition and an explicit campaign row;
 * today counts only through the fresh-partition rule. elapsedMicros is the floor of the linear share at now.
 * @example lifetimePacingEvidence({ campaign, observation, observedAt, partitions, now })
 * @complexity O(days * (partitions + rows)), <=310 days; exact bigint micros, no I/O or input mutation.
 */
export function lifetimePacingEvidence(required: { campaign: CampaignKey; observation: CampaignStatusOutput['campaigns'][number];
    observedAt: number; partitions: readonly MetricDay[]; now: number }): PacingEvidence | null {
    const budget = required.observation.currentBudget;
    if (budget?.kind !== 'lifetime' || required.observedAt > required.now) return null;
    const { start, end } = budget.flight;
    if (required.now < start || required.now >= end) return null;
    const selected = todayCampaignSpend(required);
    if (!selected) return null;
    const { partition: { day, batch } } = selected;
    const history = flightHistorySpend({ ...required, reference: batch, flightStart: start, today: day });
    if (history === null) return null;
    const elapsedMicros = BigInt(budget.amountMicros) * BigInt(required.now - start) / BigInt(end - start);
    const parsed = pacingEvidenceSchema.safeParse({ campaign: required.campaign, localDay: day, timezone: batch.timezone, budgetCurrent: true,
        budget: { kind: 'lifetime', currency: budget.currency, totalMicros: budget.amountMicros, elapsedMicros: String(elapsedMicros), flightStart: start, flightEnd: end },
        today: null, month: null, lifetime: { micros: String(history + BigInt(selected.micros)), currency: batch.currency, complete: batch.complete } });
    return parsed.success ? parsed.data : null;
}
/** Strict daily thresholds; MTD floor is the plan's proposed ten account-currency units.
 * O(1) bounded bigint operations. Missing comparisons do not become zero spend. */
function dailyRules(required: { evidence: PacingEvidence; budget: z.infer<typeof dailyBudget> }): ('today' | 'month')[] {
    const { evidence, budget } = required;
    const rules: ('today' | 'month')[] = [];
    if (comparable({ spend: evidence.today, currency: budget.currency }) && BigInt(evidence.today!.micros) > BigInt(budget.dailyMicros) * 2n) rules.push('today');
    if (Number(evidence.localDay.slice(8)) < 3 || budget.elapsedMonthMicros === null) return rules;
    if (!comparable({ spend: evidence.month, currency: budget.currency })) return rules;
    const month = BigInt(evidence.month!.micros);
    if (month >= 10000000n && month * 10n > BigInt(budget.elapsedMonthMicros) * 11n) rules.push('month');
    return rules;
}
/** Whole-budget overspend inside the flight always qualifies. Otherwise spend strictly above the
 * elapsed linear share projects past the total; that projection needs one full elapsed day. O(1) bigint. */
function lifetimeRules(required: { evidence: PacingEvidence; budget: z.infer<typeof lifetimeBudget>; now: number }): 'lifetime'[] {
    const { evidence, budget } = required;
    if (required.now < budget.flightStart || required.now >= budget.flightEnd || !comparable({ spend: evidence.lifetime, currency: budget.currency })) return [];
    const spent = BigInt(evidence.lifetime!.micros);
    if (spent > BigInt(budget.totalMicros)) return ['lifetime'];
    if (budget.elapsedMicros === null || required.now - budget.flightStart < DAY_MS) return [];
    return spent > BigInt(budget.elapsedMicros) ? ['lifetime'] : [];
}
/** One notice per campaign/local day, even when both daily rules fire. O(1). */
function pacingCandidate(required: { evidence: PacingEvidence; now: number }): AlertCandidate[] {
    const { evidence } = required;
    if (!evidence.budgetCurrent || !localDayMatches(required)) return [];
    const rules = evidence.budget.kind === 'daily' ? dailyRules({ evidence, budget: evidence.budget })
        : lifetimeRules({ ...required, budget: evidence.budget });
    if (!rules.length) return [];
    return [{ kind: 'pacing', campaign: evidence.campaign, localDay: evidence.localDay, rules,
        dedupKey: fingerprint({ parts: ['pacing', evidence.campaign, evidence.localDay] }) }];
}
/** Explicit rejection observations only; normalize descriptions independently of observation time.
 * O(c*r log r) time and O(c*r) space, <=100 campaigns and <=20 reasons each. */
function disapprovalCandidates(required: { batch: z.infer<typeof statusBatch>; now: number }): AlertCandidate[] {
    if (required.batch.observedAt > required.now) return [];
    return required.batch.campaigns.filter(observation => observation.status === 'disapproved' || (observation.rejectedChildAds ?? 0) > 0).map(observation => {
        const campaign = { pluginId: required.batch.pluginId, accountId: required.batch.accountId, vendorCampaignId: observation.vendorCampaignId };
        const reasons = [...new Set(observation.disapprovalDescriptions.map(reason => reason.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean))].sort();
        return { kind: 'ad_disapproved', campaign, reasons, dedupKey: fingerprint({ parts: ['disapproved', campaign, reasons] }) };
    });
}
/** Produce notices only from validated positive evidence. Unknown statuses never imply rejection.
 * Returns invalid_input for malformed/oversized pages, no effects.
 * @example alertCandidates({ pendingCards: [], statuses: [], pacing: [], now: 0 })
 * @complexity O(n + r log r) time, O(n + r) space; <=300 entities and <=20 reasons per campaign.
 */
export function alertCandidates(required: AlertEvidence & { now: number }): Outcome<readonly AlertCandidate[]> {
    const parsed = parseBoundary({ schema: alertEvidenceSchema.extend({ now: epochSchema }), input: required });
    if (!parsed.ok) return parsed;
    const { now, pendingCards, statuses, pacing } = parsed.value;
    const candidates: AlertCandidate[] = pendingCards.filter(card => card.status === 'pending' && card.expiresAt > now)
        .map(card => ({ kind: 'approval_waiting', cardId: card.cardId, dedupKey: fingerprint({ parts: ['approval', card.cardId] }) }));
    for (const batch of statuses) candidates.push(...disapprovalCandidates({ batch, now }));
    for (const evidence of pacing) candidates.push(...pacingCandidate({ evidence, now }));
    return { ok: true, value: [...new Map(candidates.map(candidate => [candidate.dedupKey, candidate])).values()] };
}
