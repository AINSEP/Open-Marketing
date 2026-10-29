/** @vitest-environment jsdom */
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { z } from 'zod';
import { AlertsFeed } from '../src/widgets/workspace-canvas/ui/AlertsFeed.js';
import { WorkspaceCanvas } from '../src/widgets/workspace-canvas/ui/WorkspaceCanvas.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);

/** The fixture returns surplus opaque server fields to exercise the minimal display projection. */
function fixture() {
  const { runtime } = testRuntime();
  const acknowledgeAlert = vi.fn<NonNullable<StudioApiPort['acknowledgeAlert']>>()
    .mockResolvedValue({ ok: true, value: { status: 'acknowledged' } });
  const tool = vi.fn<NonNullable<StudioApiPort['tool']>>(async ({ call }) => {
    const next = z.object({ cursor: z.string().optional() }).parse(call.input).cursor === 'next-page';
    return { ok: true, value: { status: 'completed', output: {
      items: [{ noticeId: next ? 'notice-2' : 'notice-1', createdAt: 1000,
        candidate: { kind: next ? 'ad_disapproved' : 'approval_waiting', dedupKey: 'opaque', reasons: ['Opaque reason'] },
        acknowledgement: next || acknowledgeAlert.mock.calls.length > 0 ? { at: 1100, approver: { kind: 'local_token', tokenId: 'opaque-reference' } } : null }],
      cursor: next ? null : 'next-page' } } };
  });
  const api: StudioApiPort = { ...createSampleStudioApi({ runtime }), tool, acknowledgeAlert };
  return { api, runtime, tool, acknowledgeAlert };
}

it('renders and loads more in Activity even when the legacy activity snapshot is empty', async () => {
  const f = fixture();
  const user = userEvent.setup();
  const snapshot = await f.api.snapshot({});
  if (!snapshot.ok) throw new Error('Fixture snapshot failed');
  render(createElement(WorkspaceCanvas, { target: 'activity', snapshot: { ...snapshot.value,
    rows: { ...snapshot.value.rows, activity: [] }, pages: undefined }, api: f.api, runtime: f.runtime, onOpenChat: vi.fn() }));
  await screen.findByRole('article', { name: 'Approval waiting' });
  expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Load more alerts' }));
  await screen.findByRole('article', { name: 'Ad disapproved' });
  expect(screen.getByRole('article', { name: 'Approval waiting' })).toBeDefined();
  expect(screen.getByText('Acknowledged', { exact: true })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Load more alerts' })).toBeNull();
  expect(f.tool.mock.calls[1]?.[0].call).toMatchObject({ name: 'om_alerts_list', input: { limit: 25, cursor: 'next-page' } });
});

it('acknowledges with one owner click and reloads the first page without an assistant card', async () => {
  const f = fixture();
  const user = userEvent.setup();
  render(createElement(AlertsFeed, { api: f.api, runtime: f.runtime }));
  await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
  await screen.findByText('Acknowledged', { exact: true });
  expect(f.acknowledgeAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ noticeId: 'notice-1' }));
  expect(f.tool.mock.calls.some(([input]) => input.call.name === 'om_alerts_acknowledge')).toBe(false);
  expect(f.tool).toHaveBeenCalledTimes(2);
  expect(f.tool.mock.calls[1]?.[0].call).toMatchObject({ name: 'om_alerts_list' });
  expect(f.tool.mock.calls[1]?.[0].call.input).toEqual({ limit: 25 });
});

it('renders a status message for a tool failure instead of claiming the feed is empty', async () => {
  const f = fixture();
  f.tool.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'Fixture unavailable', retryable: true } });
  render(createElement(AlertsFeed, { api: f.api, runtime: f.runtime }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Alerts unavailable. Refresh to try again.'));
  expect(screen.queryByText('No alerts')).toBeNull();
});

it('renders weekly vendor metrics separately from OM leads and keeps unavailable, unsupported and zero visible', async () => {
  const f = fixture();
  f.tool.mockResolvedValue({ ok: true, value: { status: 'completed', output: { items: [{ noticeId: 'weekly', createdAt: 1000,
    candidate: { kind: 'weekly_report', report: { days: { start: '2026-10-19', end: '2026-10-26' }, currency: 'USD', timezone: 'UTC',
      complete: false, missingDays: ['2026-10-20'], omittedCampaigns: 7,
      observations: [{ day: '2026-10-19', retrievedAt: 1000, dataThrough: 900, freshness: 'stale', restated: true }],
      campaigns: [{ campaign: { vendorCampaignId: 'campaign-a' }, metrics: { spend: '9007199254740993', clicks: '0', impressions: null, vendorConversions: '2000000' },
        verifiedLeads: { status: 'unavailable', reason: 'not_implemented' } },
      { campaign: { vendorCampaignId: 'campaign-b' }, metrics: {}, verifiedLeads: { status: 'available', count: 0 } }] } },
    acknowledgement: null }], cursor: null } } });
  render(createElement(AlertsFeed, { api: f.api, runtime: f.runtime }));
  await screen.findByRole('article', { name: 'Weekly report' });
  expect(screen.getByRole('columnheader', { name: 'Conversions (reported by platform)' })).toBeDefined();
  expect(screen.getByRole('columnheader', { name: 'Leads (OM-verified)' })).toBeDefined();
  expect(screen.getByRole('row', { name: 'campaign-a 9007199254.740993 0 Unavailable 2 Unavailable' })).toBeDefined();
  expect(screen.getByRole('row', { name: 'campaign-b Unsupported Unsupported Unsupported Unsupported 0' })).toBeDefined();
  expect(screen.getByText('Incomplete · Missing days: 2026-10-20')).toBeDefined();
  expect(screen.getByText(/2026-10-19: stale; retrieved .*; restated/)).toBeDefined();
  expect(screen.getByText('7 additional campaigns omitted')).toBeDefined();
});
