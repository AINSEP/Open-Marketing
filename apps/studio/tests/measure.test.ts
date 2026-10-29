/** @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { boundedJsonSchema } from '@open-marketing/contracts';
import { MeasurePage } from '../src/pages/measure/index.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);
const query = { pluginId: 'fixture-ads', connectionId: 'connection', accountId: 'account', days: { start: '2026-10-01', end: '2026-10-03' } };
const output = { query, currency: 'USD', timezone: 'America/Los_Angeles', attributionModel: 'last_paid_touch_30d.v1',
  workspaceUnattributed: { status: 'available', count: 2 }, complete: false, missingDays: ['2026-10-02'],
  campaigns: [
    { campaign: { pluginId: query.pluginId, accountId: query.accountId, vendorCampaignId: 'campaign-zero' },
      metrics: { spend: '0', impressions: '100', clicks: null, vendorConversions: '2000000' }, verifiedLeads: { status: 'available', count: 0 } },
    { campaign: { pluginId: query.pluginId, accountId: query.accountId, vendorCampaignId: 'lead-only' },
      metrics: { spend: null, impressions: null, clicks: null, vendorConversions: null }, verifiedLeads: { status: 'available', count: 1 } },
  ], observations: [{ day: '2026-10-01', retrievedAt: 2000, dataThrough: 1000, freshness: 'stale', finality: 'provisional', restated: true }] };

/** Shared fixture transport only; no server, vendor or real credentials. */
function fixture(required: { reconnect?: boolean; malformed?: boolean } = {}) {
  const host = testRuntime(), sample = createSampleStudioApi({ runtime: host.runtime });
  const integrations = vi.fn<NonNullable<StudioApiPort['addons']>['integrations']>().mockResolvedValue({ ok: true, value: {
    items: [{ connectionId: query.connectionId, pluginId: query.pluginId, status: required.reconnect ? 'reconnect_required' : 'saved' }], cursor: null,
  } });
  const tool = vi.fn<NonNullable<StudioApiPort['tool']>>().mockImplementation(async input => ({ ok: true, value: {
    status: 'completed', output: boundedJsonSchema.parse(required.malformed ? { campaigns: [{ metrics: { spend: '1.5' } }] }
      : input.call.name === 'om_measure_refresh' ? { jobId: 'job', operationId: 'job-operation', status: 'enqueued' } : output),
  } }));
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!, integrations }, tool };
  return { ...host, api, tool, integrations };
}
async function choosePeriod() {
  await waitFor(() => expect((screen.getByLabelText('Connection') as HTMLSelectElement).value).toBe(query.connectionId));
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: query.accountId } });
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: query.days.start } });
  fireEvent.change(screen.getByLabelText('End date (exclusive)'), { target: { value: query.days.end } });
}

it('separates platform conversions and OM leads, preserving zero/unavailable and attribution evidence', async () => {
  const f = fixture();
  render(createElement(MeasurePage, { api: f.api, runtime: f.runtime }));
  await choosePeriod();
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  const campaign = await screen.findByRole('rowheader', { name: 'campaign-zero' });
  const row = within(campaign.closest('tr')!);
  expect(row.getByRole('cell', { name: '0 USD' })).toBeTruthy();
  expect(row.getByRole('cell', { name: 'Unavailable' })).toBeTruthy();
  expect(row.getByRole('cell', { name: '0' })).toBeTruthy();
  expect(row.getByRole('cell', { name: '2' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'Conversions (reported by platform)' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: 'Leads (OM-verified)' })).toBeTruthy();
  expect(within(screen.getByRole('rowheader', { name: 'lead-only' }).closest('tr')!).getAllByRole('cell', { name: 'Unavailable' })).toHaveLength(4);
  expect(screen.getByText(/Workspace unattributed enquiries: 2/)).toBeTruthy();
  expect(screen.getByText(/Last paid touch within 30 days.*last_paid_touch_30d.v1/).textContent).toContain('only after consent');
  expect(screen.getByText(/Coverage: Incomplete. Missing days: 2026-10-02/)).toBeTruthy();
  expect(screen.getByText(/2026-10-01: stale; provisional;.*restated/)).toBeTruthy();
  expect(f.integrations).toHaveBeenCalledWith({ query: { limit: 100 }, signal: expect.any(AbortSignal) });
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: 'other-account' } });
  expect(screen.queryByRole('table')).toBeNull();
});

it('uses integrations readiness for reconnect guidance', async () => {
  const f = fixture({ reconnect: true });
  render(createElement(MeasurePage, { api: f.api, runtime: f.runtime }));
  await screen.findByText(/Reconnect required/);
  expect(screen.getByRole('link', { name: 'Open Integrations' }).getAttribute('href')).toBe('#/addons/integrations');
  expect(f.tool).not.toHaveBeenCalled();
});

it('refreshes with an injected syncId and reads persisted results only on Load', async () => {
  const f = fixture();
  render(createElement(MeasurePage, { api: f.api, runtime: f.runtime }));
  await choosePeriod();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText(/Refresh queued. Use Load/);
  expect(screen.queryByRole('table')).toBeNull();
  expect(f.tool).toHaveBeenCalledOnce();
  expect(f.tool).toHaveBeenLastCalledWith({ call: { name: 'om_measure_refresh', operationId: expect.stringMatching(/^test-/),
    input: { syncId: expect.stringMatching(/^test-/), query } }, signal: expect.any(AbortSignal) });
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  await screen.findByRole('table');
  expect(f.tool).toHaveBeenCalledTimes(2);
  expect(f.tool).toHaveBeenLastCalledWith({ call: { name: 'om_measure_results', input: { query }, operationId: expect.stringMatching(/^test-/) }, signal: expect.any(AbortSignal) });
  expect(f.pending()).toBe(0);
});

it('rejects malformed output without rendering rows', async () => {
  const f = fixture({ malformed: true });
  render(createElement(MeasurePage, { api: f.api, runtime: f.runtime }));
  await choosePeriod();
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Results unavailable');
  expect(screen.queryByRole('table')).toBeNull();
});

it('rejects more than 31 days before calling a tool', async () => {
  const f = fixture();
  render(createElement(MeasurePage, { api: f.api, runtime: f.runtime }));
  await choosePeriod();
  fireEvent.change(screen.getByLabelText('End date (exclusive)'), { target: { value: '2026-11-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  expect((await screen.findByRole('alert')).textContent).toContain('1–31 days');
  expect(f.tool).not.toHaveBeenCalled();
});
