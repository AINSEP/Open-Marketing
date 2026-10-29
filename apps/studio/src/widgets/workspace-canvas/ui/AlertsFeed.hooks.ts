/** Activity reads a minimal alert projection; persistence and authority stay on the server. */
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { epochSchema, idSchema, metricValuesSchema } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

/** OM-verified lead count, or the server's reason it is unavailable. */
const leadCountSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('available'), count: epochSchema }),
  z.object({ status: z.literal('unavailable'), reason: z.string() })]);
/** Minimal display projection; the server owns full row validation, source identity and byte bounds. */
const weeklySchema = z.object({ days: z.object({ start: z.iso.date(), end: z.iso.date() }),
  currency: z.string().nullable(), timezone: z.string().nullable(), complete: z.boolean(), missingDays: z.array(z.iso.date()).max(31),
  observations: z.array(z.object({ day: z.iso.date(), retrievedAt: epochSchema, dataThrough: epochSchema,
    freshness: z.enum(['fresh', 'stale']), restated: z.boolean() })).max(31),
  campaigns: z.array(z.object({ campaign: z.object({ vendorCampaignId: idSchema }), metrics: metricValuesSchema,
    verifiedLeads: leadCountSchema })).max(10), omittedCampaigns: z.number().int().nonnegative(),
  workspaceUnattributed: leadCountSchema.optional() });
/** Only displayed fields are projected; approver identities stay opaque. */
const noticeSchema = z.object({ noticeId: idSchema, createdAt: epochSchema,
  candidate: z.discriminatedUnion('kind', [z.object({ kind: z.enum(['approval_waiting', 'ad_disapproved', 'pacing']) }),
    z.object({ kind: z.literal('weekly_report'), report: weeklySchema })]),
  acknowledgement: z.object({ at: epochSchema }).nullable() });
const pageSchema = z.object({ items: z.array(noticeSchema).max(100), cursor: z.string().min(1).max(4096).nullable() });
type Notice = z.infer<typeof noticeSchema>;
/** The workspace's existing injected API and lifecycle dependencies. */
export interface AlertsFeedProps { readonly api: StudioApiPort; readonly runtime: StudioRuntime }
const titles: Record<Notice['candidate']['kind'], string> = {
  approval_waiting: 'Approval waiting', ad_disapproved: 'Ad disapproved', pacing: 'Overspend / pacing',
  weekly_report: 'Weekly report',
};

/** Missing cells preserve unsupported vs unavailable; observed zero remains visible. O(1). */
export function metricText(required: { value?: string | null }): string {
  if (required.value === undefined) return 'Unsupported';
  return required.value === null ? 'Unavailable' : required.value;
}
/** Exact six-decimal display for currency micros and platform conversion millionths, without Number rounding. */
export function scaledMetricText(required: { value?: string | null }): string {
  if (required.value == null) return metricText(required);
  const digits = required.value.padStart(7, '0'), fraction = digits.slice(-6).replace(/0+$/, '');
  return digits.slice(0, -6) + (fraction ? '.' + fraction : '');
}
/** Older notices predate the field and show Unavailable, never 0. O(1). */
function unattributedText(required: { value?: z.infer<typeof leadCountSchema> }): string {
  if (required.value === undefined) return 'Unavailable';
  return required.value.status === 'available' ? String(required.value.count) : `Unavailable (${required.value.reason})`;
}
/** Display only; no cross-campaign totals or OM/vendor arithmetic. O(rows + days), bounded by the notice. */
function weeklyDisplay(required: { report: z.infer<typeof weeklySchema> }) {
  const report = required.report;
  return { period: `${report.days.start} to ${report.days.end} (end exclusive)`,
    currency: report.currency ?? 'Unavailable', timezone: report.timezone ?? 'Unavailable',
    coverage: report.complete ? 'Complete' : 'Incomplete', missingDays: report.missingDays.join(', ') || 'None',
    observations: report.observations.map(item => `${item.day}: ${item.freshness}; retrieved ${new Date(item.retrievedAt).toISOString()}; data through ${new Date(item.dataThrough).toISOString()}${item.restated ? '; restated' : ''}`),
    campaigns: report.campaigns.map(item => ({ id: item.campaign.vendorCampaignId, spend: scaledMetricText({ value: item.metrics.spend }),
      clicks: metricText({ value: item.metrics.clicks }), impressions: metricText({ value: item.metrics.impressions }),
      conversions: scaledMetricText({ value: item.metrics.vendorConversions }),
      leads: item.verifiedLeads.status === 'available' ? String(item.verifiedLeads.count) : 'Unavailable' })),
    omittedCampaigns: report.omittedCampaigns, unattributed: unattributedText({ value: report.workspaceUnattributed }) };
}

/** One page per action, no polling. Refresh replaces loaded pages with current persisted state.
 * Failure retains existing rows; teardown aborts reads before they update the view.
 * @example useAlertsFeed({ api, runtime });
 * @complexity <=100 projected notices per read; memory grows only with explicit Load more actions.
 */
export function useAlertsFeed(required: AlertsFeedProps) {
  const [items, setItems] = useState<Notice[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const loading = useRef(false);

  /** Read and validate one tool page; never turn failed or pending tool output into an empty feed. */
  const load = async (input: { cursor?: string }): Promise<void> => {
    if (!required.api.tool) { setLoaded(true); return; }
    if (loading.current) return;
    const signal = controller.current?.signal;
    loading.current = true; setBusy(true); setStatus('');
    try {
      const result = await required.api.tool?.({ call: { name: 'om_alerts_list', input: { limit: 25, ...input },
        operationId: required.runtime.ids.next({}) }, signal });
      if (!result?.ok || result.value.status !== 'completed') throw new Error('Alert feed unavailable');
      const page = pageSchema.parse(result.value.output);
      if (signal?.aborted) return;
      setItems(current => input.cursor ? [...current, ...page.items] : page.items);
      setCursor(page.cursor); setLoaded(true);
    } catch {
      if (!signal?.aborted) setStatus('Alerts unavailable. Refresh to try again.');
    } finally {
      if (!signal?.aborted) { loading.current = false; setBusy(false); }
    }
  };

  useEffect(() => {
    const active = required.runtime.abort(); controller.current = active; loading.current = false;
    setItems([]); setCursor(null); setLoaded(false);
    void load({});
    return () => active.abort();
  }, [required.api, required.runtime]);

  /** Owner writes once, then reads persisted state; failure keeps the current rows. */
  const acknowledge = async (input: { noticeId: string }): Promise<void> => {
    if (busy || !required.api.acknowledgeAlert) return;
    setBusy(true);
    const result = await required.api.acknowledgeAlert({ noticeId: input.noticeId, signal: controller.current?.signal });
    if (!result.ok) {
      setStatus('Acknowledge failed. Refresh to try again.'); setBusy(false);
      return;
    }
    void load({});
  };

  const refresh = (): void => { void load({}); };
  const loadMore = (): void => { if (cursor) void load({ cursor }); };
  return { rows: items.map(item => ({ noticeId: item.noticeId, title: titles[item.candidate.kind],
    createdAt: new Date(item.createdAt).toLocaleString(), acknowledged: item.acknowledgement !== null, busy,
    onAcknowledge: item.acknowledgement === null && required.api.acknowledgeAlert
      ? (): void => { void acknowledge({ noticeId: item.noticeId }); } : undefined,
    weekly: item.candidate.kind === 'weekly_report' ? weeklyDisplay({ report: item.candidate.report }) : null })),
    busy, loaded, status, hasMore: cursor !== null, refresh, loadMore };
}
/** Row props are derived from the hook's display model. */
export type AlertRowProps = ReturnType<typeof useAlertsFeed>['rows'][number];
