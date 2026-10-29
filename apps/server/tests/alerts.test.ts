/** Written-only rule evidence; no vendor, real clock, or credentials. */
import { describe, expect, it } from 'vitest';
import { alertCandidates, dailyPacingEvidence, type AlertEvidence, type PacingEvidence } from '../src/alerts/index.js';
import type { Outcome } from '@open-marketing/contracts';
import type { MetricDay } from '@open-marketing/measure';

const now = Date.parse('2026-10-03T12:00:00Z');
const campaign = { pluginId: 'fixture-ads', accountId: 'account', vendorCampaignId: 'campaign' };
/** Fail explicitly when a rule invocation unexpectedly rejects the fixture. */
function value<T>({ result }: { result: Outcome<T> }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
}
/** Independent budget/spend facts; options alter just the branch under test. */
function pacing(options: Partial<PacingEvidence> = {}): PacingEvidence {
    return { campaign, localDay: '2026-10-03', timezone: 'UTC', budgetCurrent: true,
        budget: { kind: 'daily', currency: 'USD', dailyMicros: '10000000', elapsedMonthMicros: '30000000' },
        today: { currency: 'USD', micros: '20000000', complete: true },
        month: { currency: 'USD', micros: '33000000', complete: true }, lifetime: null, ...options };
}
/** Invoke the public decision boundary with a bounded, otherwise empty page. */
function decide(options: Partial<AlertEvidence & { now: number }> = {}) {
    return value({ result: alertCandidates({ pendingCards: [], statuses: [], pacing: [], now, ...options }) });
}

describe('server alert rules', () => {
    it('includes pending unexpired approvals, with no age delay or duplicate card notice', () => {
        const pending = { cardId: 'pending', status: 'pending' as const, expiresAt: now + 1 };
        expect(decide({ pendingCards: [pending, pending, { ...pending, cardId: 'expired', expiresAt: now },
            { ...pending, cardId: 'answered', status: 'answered' }] }).map(item => item.kind)).toEqual(['approval_waiting']);
        expect(decide({ pendingCards: [pending] })[0]).toMatchObject({ cardId: 'pending' });
    });
    it('normalizes rejection evidence and excludes timestamps from dedup identity', () => {
        const batch = { pluginId: campaign.pluginId, accountId: campaign.accountId, observedAt: now - 1, complete: false,
            campaigns: [{ vendorCampaignId: campaign.vendorCampaignId, status: 'disapproved' as const,
                disapprovalDescriptions: [' POLICY   A ', 'Policy B', 'policy a'] }] };
        const first = decide({ statuses: [batch] });
        const replay = decide({ statuses: [{ ...batch, observedAt: now, campaigns: [{ ...batch.campaigns[0]!, disapprovalDescriptions: ['policy b', 'policy a'] }] }] });
        expect(first).toEqual(replay);
        expect(first[0]).toMatchObject({ kind: 'ad_disapproved', campaign, reasons: ['policy a', 'policy b'] });
        expect(decide({ statuses: [{ ...batch, campaigns: [{ ...batch.campaigns[0]!, disapprovalDescriptions: ['new reason'] }] }] })[0]?.dedupKey).not.toBe(first[0]?.dedupKey);
        expect(decide({ statuses: [{ ...batch, accountId: 'other' }] })[0]?.dedupKey).not.toBe(first[0]?.dedupKey);
        expect(decide({ statuses: [{ ...batch, observedAt: now + 1 }] })).toEqual([]);
        expect(decide({ statuses: [{ ...batch, campaigns: [{ ...batch.campaigns[0]!, status: 'unknown' }] }] })).toEqual([]);
    });
    it('includes an active campaign with rejected child ads without changing its status', () => {
        const observation = { vendorCampaignId: campaign.vendorCampaignId, status: 'active' as const,
            rejectedChildAds: 2, disapprovalDescriptions: ['Child ad rejected'] };
        const notices = decide({ statuses: [{ pluginId: campaign.pluginId, accountId: campaign.accountId,
            observedAt: now, complete: true, campaigns: [observation] }] });
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ kind: 'ad_disapproved', campaign, reasons: ['child ad rejected'] });
        expect(observation.status).toBe('active');
    });
    it.each([0, undefined])('omits active campaigns without positive rejected-child evidence (%s)', rejectedChildAds => {
        expect(decide({ statuses: [{ pluginId: campaign.pluginId, accountId: campaign.accountId,
            observedAt: now, complete: true, campaigns: [{ vendorCampaignId: campaign.vendorCampaignId,
                status: 'active', rejectedChildAds, disapprovalDescriptions: [] }] }] })).toEqual([]);
    });
    it('emits exactly one notice when the campaign and a child ad are both disapproved', () => {
        const batch = { pluginId: campaign.pluginId, accountId: campaign.accountId, observedAt: now, complete: true,
            campaigns: [{ vendorCampaignId: campaign.vendorCampaignId, status: 'disapproved' as const,
                rejectedChildAds: 1, disapprovalDescriptions: ['Rejected'] }] };
        const notices = decide({ statuses: [batch] });
        expect(notices).toHaveLength(1);
        expect(notices).toEqual(decide({ statuses: [{ ...batch, campaigns: [{ ...batch.campaigns[0]!, rejectedChildAds: 0 }] }] }));
    });
    it('uses strict greater-than thresholds and emits one pacing notice for both rules', () => {
        expect(decide({ pacing: [pacing()] })).toEqual([]);
        const evidence = pacing({ today: { currency: 'USD', micros: '20000001', complete: true },
            month: { currency: 'USD', micros: '33000001', complete: true } });
        const notices = decide({ pacing: [evidence, evidence] });
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ kind: 'pacing', campaign, localDay: '2026-10-03', rules: ['today', 'month'] });
        expect(decide({ pacing: [{ ...evidence, today: null }] })[0]?.dedupKey).toBe(notices[0]?.dedupKey);
        expect(decide({ pacing: [{ ...evidence, localDay: '2026-10-04' }], now: Date.parse('2026-10-04T12:00:00Z') })[0]?.dedupKey).not.toBe(notices[0]?.dedupKey);
    });
    it('honors the account-local day-three guard and fixed spend floor', () => {
        const evidence = pacing({ today: null, month: { currency: 'USD', micros: '10000000', complete: true },
            budget: { kind: 'daily', currency: 'USD', dailyMicros: '1', elapsedMonthMicros: '1' } });
        expect(decide({ pacing: [evidence] })[0]).toMatchObject({ rules: ['month'] });
        expect(decide({ pacing: [{ ...evidence, month: { currency: 'USD', micros: '9999999', complete: true } }] })).toEqual([]);
        expect(decide({ now: Date.parse('2026-10-03T01:00:00Z'), pacing: [{ ...evidence, timezone: 'America/Los_Angeles', localDay: '2026-10-02' }] })).toEqual([]);
    });
    it('skips missing, incomplete, wrong-currency, stale-budget and wrong-day evidence', () => {
        const high = { currency: 'USD', micros: '999999999', complete: true };
        const evidence = pacing({ today: high, month: high });
        expect(decide({ pacing: [{ ...evidence, today: null, month: null }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, today: { ...high, complete: false }, month: null }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, today: { ...high, currency: 'EUR' }, month: null }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, budgetCurrent: false }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, localDay: '2026-10-02' }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, timezone: 'invalid/timezone' }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, today: null, budget: { kind: 'daily', currency: 'USD', dailyMicros: '1', elapsedMonthMicros: null } }] })).toEqual([]);
    });
    it('compares micros beyond safe integer range without rounding', () => {
        const budget = '9007199254740993';
        const evidence = pacing({ budget: { kind: 'daily', currency: 'USD', dailyMicros: budget, elapsedMonthMicros: null },
            today: { currency: 'USD', complete: true, micros: '18014398509481986' }, month: null });
        expect(decide({ pacing: [evidence] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, today: { currency: 'USD', complete: true, micros: '18014398509481987' } }] })[0]).toMatchObject({ rules: ['today'] });
    });
    it('uses a separate lifetime allocation rule including whole-budget excess', () => {
        const evidence = pacing({ today: null, month: null,
            budget: { kind: 'lifetime', currency: 'USD', totalMicros: '100', elapsedMicros: '50', flightStart: now - 1000, flightEnd: now + 1000 },
            lifetime: { currency: 'USD', complete: true, micros: '55' } });
        expect(decide({ pacing: [evidence] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, lifetime: { currency: 'USD', complete: true, micros: '56' } }] })[0]).toMatchObject({ rules: ['lifetime'] });
        const budget = { kind: 'lifetime' as const, currency: 'USD', totalMicros: '100', elapsedMicros: null, flightStart: now - 1000, flightEnd: now + 1000 };
        expect(decide({ pacing: [{ ...evidence, budget, lifetime: { currency: 'USD', complete: true, micros: '101' } }] })[0]).toMatchObject({ rules: ['lifetime'] });
        expect(decide({ pacing: [{ ...evidence, budget: { ...budget, flightStart: now + 1 } }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, lifetime: null }] })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, budget }] })).toEqual([]);
    });
    it.each([null, '50'])('stops lifetime pacing at flightEnd even with overspend (elapsed=%s)', elapsedMicros => {
        const evidence = pacing({ today: null, month: null,
            budget: { kind: 'lifetime', currency: 'USD', totalMicros: '100', elapsedMicros, flightStart: now - 1000, flightEnd: now },
            lifetime: { currency: 'USD', complete: true, micros: '101' } });
        expect(decide({ pacing: [evidence], now: now - 1 })[0]).toMatchObject({ rules: ['lifetime'] });
        expect(decide({ pacing: [evidence] })).toEqual([]);
        expect(decide({ pacing: [evidence], now: now + 1 })).toEqual([]);
        expect(decide({ pacing: [{ ...evidence, localDay: '2026-10-04' }], now: now + 86400000 })).toEqual([]);
    });
    it('rejects malformed and oversized pages before emitting any candidates', () => {
        expect(alertCandidates({ pendingCards: [], statuses: [], pacing: [pacing({ today: { currency: 'USD', complete: true, micros: '1.5' } })], now })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        const card = { cardId: 'a', status: 'pending' as const, expiresAt: now + 1 };
        expect(alertCandidates({ pendingCards: Array.from({ length: 101 }, () => card), statuses: [], pacing: [], now })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        const batch = { pluginId: 'ads', accountId: 'a', observedAt: now, complete: true, campaigns: [{ vendorCampaignId: 'c', status: 'active' as const, disapprovalDescriptions: [] }] };
        expect(alertCandidates({ pendingCards: [], statuses: Array.from({ length: 101 }, () => batch), pacing: [], now })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    });
});

/** Valid campaign-day fixture; only the evidence under test is changed by each case. */
function todayPartition(options: Partial<MetricDay['batch']> = {}): MetricDay {
    return { day: '2026-10-03', syncId: 'stored-sync', previousSyncId: null, batch: {
        schema: 'report.metrics.v1', pluginId: campaign.pluginId, connectionId: 'connection', accountId: campaign.accountId,
        currency: 'USD', timezone: 'UTC', grain: 'campaign', days: { start: '2026-10-03', end: '2026-10-04' },
        mapping: { pluginId: campaign.pluginId, version: '1', grains: { campaign: { spend: { vendorField: 'cost', meaning: 'Spend in micros' } } } },
        retrievedAt: now - 16 * 60000, dataThrough: now - 16 * 60000, complete: true, freshness: 'fresh', finality: 'provisional', restated: false,
        rows: [{ day: '2026-10-03', entity: { grain: 'campaign', vendorCampaignId: campaign.vendorCampaignId }, metrics: { spend: '20000001' } }],
        ...options,
    } };
}
/** Default projection has evidence from the previous evaluation slot. */
function projection(options: Partial<Parameters<typeof dailyPacingEvidence>[0]> = {}) {
    return dailyPacingEvidence({ campaign, observation: { vendorCampaignId: campaign.vendorCampaignId, status: 'active', disapprovalDescriptions: [],
        currentBudget: { kind: 'daily', currency: 'USD', amountMicros: '10000000' } }, observedAt: now,
        partitions: [todayPartition()], now, ...options });
}

describe('B2 daily pacing projection', () => {
    it('uses fresh complete stored today spend and the current budget to emit an overspend notice', () => {
        const evidence = projection();
        expect(evidence).toEqual({ campaign, localDay: '2026-10-03', timezone: 'UTC', budgetCurrent: true,
            budget: { kind: 'daily', currency: 'USD', dailyMicros: '10000000', elapsedMonthMicros: null },
            today: { micros: '20000001', currency: 'USD', complete: true }, month: null, lifetime: null });
        expect(decide({ pacing: [evidence!] })).toMatchObject([{ kind: 'pacing', rules: ['today'] }]);
        const incomplete = projection({ partitions: [todayPartition({ complete: false })] });
        expect(incomplete?.today?.complete).toBe(false);
        expect(decide({ pacing: [incomplete!] })).toEqual([]);
    });
    it('keeps 30-digit money exact and omits 31-digit budget/spend instead of truncating', () => {
        const observation = { vendorCampaignId: campaign.vendorCampaignId, status: 'active' as const, disapprovalDescriptions: [],
            currentBudget: { kind: 'daily' as const, currency: 'USD', amountMicros: '9'.repeat(30) } };
        expect(projection({ observation })?.budget).toMatchObject({ dailyMicros: '9'.repeat(30) });
        expect(projection({ observation: { ...observation, currentBudget: { ...observation.currentBudget, amountMicros: '9'.repeat(31) } } })).toBeNull();
        const row = todayPartition().batch.rows[0]!;
        expect(projection({ partitions: [todayPartition({ rows: [{ ...row, metrics: { spend: '9'.repeat(31) } }] })] })).toBeNull();
    });
    it('omits stale, old, future-retrieved, missing and unavailable spend evidence', () => {
        const row = todayPartition().batch.rows[0]!;
        for (const partition of [todayPartition({ freshness: 'stale' }), todayPartition({ retrievedAt: now - 31 * 60000 }),
            todayPartition({ retrievedAt: now + 1 }), todayPartition({ rows: [] }),
            todayPartition({ rows: [{ ...row, metrics: { spend: null } }] }), todayPartition({ rows: [{ ...row, metrics: {} }] })]) {
            expect(projection({ partitions: [partition] })).toBeNull();
        }
        expect(projection({ observedAt: now + 1 })).toBeNull();
        expect(projection({ partitions: [] })).toBeNull();
    });
    it('selects the previous UTC date at Los Angeles local midnight', () => {
        const instant = Date.parse('2026-10-28T03:00:00Z');
        const partitions = ['2026-10-27', '2026-10-28'].map((day, index) => {
            const partition = todayPartition({ timezone: 'America/Los_Angeles', retrievedAt: instant, dataThrough: instant,
                days: { start: '2026-10-27', end: '2026-10-29' } });
            return { ...partition, day, batch: { ...partition.batch, rows: [{ ...partition.batch.rows[0]!, day,
                metrics: { spend: String(20000001 + index) } }] } };
        });
        expect(projection({ now: instant, observedAt: instant, partitions })).toMatchObject({ localDay: '2026-10-27', today: { micros: '20000001' } });
    });
    it('leaves lifetime and absent budgets unknown without attested history', () => {
        const observation = { vendorCampaignId: campaign.vendorCampaignId, status: 'active' as const, disapprovalDescriptions: [] };
        expect(projection({ observation })).toBeNull();
        expect(projection({ observation: { ...observation, currentBudget: { kind: 'lifetime', amountMicros: '10000000', currency: 'USD',
            flight: { start: now - 1000, end: now + 1000 } } } })).toBeNull();
    });
});
