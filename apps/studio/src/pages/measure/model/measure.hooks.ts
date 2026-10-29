/** Display projections only; reporting ownership and authority stay on the server. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { z } from 'zod';
import { appErrorSchema, campaignKeySchema, epochSchema, idSchema, integrationListSchema, reportMetricsInputSchema, metricValuesSchema } from '@open-marketing/contracts';
import type { IntegrationSummary } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';
import { metricText, scaledMetricText } from '../../../widgets/workspace-canvas/index.js';

export type MeasureProps = { api: StudioApiPort; runtime: StudioRuntime };
const querySchema = z.strictObject({ pluginId: idSchema, connectionId: idSchema, accountId: idSchema,
  days: reportMetricsInputSchema.shape.days.refine(days => Date.parse(days.end) - Date.parse(days.start) <= 31 * 86400000) });
const leadSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('available'), count: epochSchema }),
  z.object({ status: z.literal('unavailable'), reason: appErrorSchema.shape.code })]);
const resultsSchema = z.object({ query: querySchema, currency: z.string().length(3).nullable(), timezone: z.string().max(100).nullable(),
  attributionModel: z.literal('last_paid_touch_30d.v1'), workspaceUnattributed: leadSchema,
  complete: z.boolean(), missingDays: z.array(z.iso.date()).max(31),
  campaigns: z.array(z.object({ campaign: campaignKeySchema, metrics: metricValuesSchema, verifiedLeads: leadSchema })).max(5000),
  observations: z.array(z.object({ day: z.iso.date(), retrievedAt: epochSchema, dataThrough: epochSchema,
    freshness: z.enum(['fresh', 'stale']), finality: z.enum(['provisional', 'final']), restated: z.boolean() })).max(31) });
const receiptSchema = z.object({ jobId: idSchema, operationId: idSchema, status: z.enum(['enqueued', 'existing']) });

/** Use the existing bounded HTTP tool call; null acknowledges an enqueue, never data.
 * Throws on failed/pending/malformed replies; the hook displays a fixed error.
 * @complexity One call and O(output bytes) parsing, bounded by the HTTP adapter.
 */
async function reportingCall(required: MeasureProps & { action: 'load' | 'refresh'; query: z.infer<typeof querySchema>; signal: AbortSignal }): Promise<z.infer<typeof resultsSchema> | null> {
  const { api, runtime, action, query, signal } = required;
  const response = await api.tool?.({ call: { name: action === 'load' ? 'om_measure_results' : 'om_measure_refresh',
    input: action === 'load' ? { query } : { syncId: runtime.ids.next({}), query }, operationId: runtime.ids.next({}) }, signal });
  if (!response?.ok || response.value.status !== 'completed') throw new Error('Reporting request unavailable');
  if (action === 'refresh') { receiptSchema.parse(response.value.output); return null; }
  return resultsSchema.parse(response.value.output);
}

/** Exact count or explicit failure; unavailable never becomes a numeric zero. */
function leadText(required: { value: z.infer<typeof leadSchema> }): string {
  return required.value.status === 'available' ? String(required.value.count) : `Unavailable (${required.value.reason})`;
}
/** Reuse exact integer formatters; O(campaigns + days), bounded by display schemas. */
function resultsDisplay(required: { report: z.infer<typeof resultsSchema> }) {
  const report = required.report;
  return { period: `${report.query.days.start} to ${report.query.days.end} (end exclusive)`, timezone: report.timezone ?? 'Unavailable',
    coverage: report.complete ? 'Complete' : 'Incomplete', missingDays: report.missingDays.join(', ') || 'None',
    unattributed: leadText({ value: report.workspaceUnattributed }),
    rows: report.campaigns.map(row => ({ id: row.campaign.vendorCampaignId,
      spend: scaledMetricText({ value: row.metrics.spend }) + (typeof row.metrics.spend === 'string' ? ` ${report.currency ?? 'Unknown currency'}` : ''),
      impressions: metricText({ value: row.metrics.impressions }), clicks: metricText({ value: row.metrics.clicks }),
      conversions: scaledMetricText({ value: row.metrics.vendorConversions }), leads: leadText({ value: row.verifiedLeads }) })),
    observations: report.observations.map(item => `${item.day}: ${item.freshness}; ${item.finality}; retrieved ${new Date(item.retrievedAt).toISOString()}; data through ${item.dataThrough === 0 ? 'unknown' : new Date(item.dataThrough).toISOString()}${item.restated ? '; restated' : ''}`) };
}

/** One explicit results read or enqueue per action; integrations supply readiness.
 * Editing the query clears old evidence; unmount aborts I/O. No polling or retries.
 * @example useMeasure({ api, runtime })
 * @complexity <=100 connections, <=5,000 campaign rows and <=31 evidence dates.
 */
export function useMeasure(required: MeasureProps) {
  const { api, runtime } = required;
  const [connections, setConnections] = useState<IntegrationSummary[]>([]);
  const [form, setForm] = useState({ connectionId: '', accountId: '', start: '', end: '' });
  const [report, setReport] = useState<z.infer<typeof resultsSchema> | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [status, setStatus] = useState('');
  const controller = useRef<AbortController | null>(null), pending = useRef(false);
  const selected = connections.find(item => item.connectionId === form.connectionId);

  /** API response is validated before any selector or readiness state is accepted. */
  async function initialize(input: { signal: AbortSignal }) {
    try {
      const response = await api.addons?.integrations({ query: { limit: 100 }, signal: input.signal });
      if (!response?.ok) throw new Error('Integrations unavailable');
      const page = integrationListSchema.parse(response.value);
      if (input.signal.aborted) return;
      setConnections(page.items);
      setForm(current => ({ ...current, connectionId: page.items[0]?.connectionId ?? '' }));
    } catch { if (!input.signal.aborted) setError('Connections unavailable. Open Integrations to check your setup.'); }
    finally { if (!input.signal.aborted) { pending.current = false; setBusy(false); } }
  }
  useEffect(() => {
    const active = runtime.abort(); controller.current = active; pending.current = true; setBusy(true);
    setConnections([]); setReport(null); setError(''); setStatus('');
    void initialize({ signal: active.signal });
    return () => active.abort();
  }, [api, runtime]);

  /** One shared tool transport; malformed/pending results never produce table rows. */
  async function act(input: { action: 'load' | 'refresh' }) {
    if (pending.current || !controller.current) return;
    const query = querySchema.safeParse({ pluginId: selected?.pluginId, connectionId: form.connectionId, accountId: form.accountId,
      days: { start: form.start, end: form.end } });
    if (!query.success) { setError('Choose a connection, account and a period of 1–31 days (end exclusive).'); return; }
    const signal = controller.current.signal;
    pending.current = true; setBusy(true); setError(''); setStatus(''); setReport(null);
    try {
      const result = await reportingCall({ api, runtime, action: input.action, query: query.data, signal });
      if (signal.aborted) return;
      if (result === null) setStatus('Refresh queued. Use Load to read persisted results after it completes.');
      else setReport(result);
    } catch { if (!signal.aborted) setError('Results unavailable. Check the connection and any pending approval, then try again.'); }
    finally { if (!signal.aborted) { pending.current = false; setBusy(false); } }
  }
  function update(input: Partial<typeof form>) { setForm(current => ({ ...current, ...input })); setReport(null); setStatus(''); setError(''); }
  // React change/click callback ABIs; all derived state and handlers stay outside TSX.
  const onConnection = (event: ChangeEvent<HTMLSelectElement>) => update({ connectionId: event.target.value });
  const onAccount = (event: ChangeEvent<HTMLInputElement>) => update({ accountId: event.target.value });
  const onStart = (event: ChangeEvent<HTMLInputElement>) => update({ start: event.target.value });
  const onEnd = (event: ChangeEvent<HTMLInputElement>) => update({ end: event.target.value });
  const load = () => { void act({ action: 'load' }); }, refresh = () => { void act({ action: 'refresh' }); };
  return { form, connections, busy, error, status, reconnect: selected?.status === 'reconnect_required',
    disconnected: selected?.status === 'disconnected', display: report ? resultsDisplay({ report }) : null,
    onConnection, onAccount, onStart, onEnd, load, refresh };
}
export type MeasureDisplay = NonNullable<ReturnType<typeof useMeasure>['display']>;
