/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LeadsPage } from '../src/pages/leads/index.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import type { LeadDisplay } from '../src/shared/api/validation.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);

const unattributed: LeadDisplay = { leadId: 'lead-1', source: { kind: 'form', ref: 'submission-1' },
  stage: 'new', revision: 1, erased: false, attribution: { campaign: null } };
const paid: LeadDisplay = { ...unattributed, leadId: 'lead-2', source: { kind: 'manual', ref: 'enquiry-2' },
  attribution: { campaign: { pluginId: 'fixture-ads', accountId: 'fixture-account', vendorCampaignId: 'paid-campaign' } } };

/** Real sample API supplies unrelated methods; the only fixtures are lead transport outcomes. */
function fixture(required: { items?: LeadDisplay[]; conflict?: boolean } = {}) {
  const host = testRuntime();
  let items = required.items ?? [unattributed, paid];
  const tool: NonNullable<StudioApiPort['tool']> = vi.fn(async () => ({ ok: true as const, value: { status: 'completed' as const, output: { items, cursor: null } } }));
  const setLeadStage: NonNullable<StudioApiPort['setLeadStage']> = vi.fn(async (input: Parameters<NonNullable<StudioApiPort['setLeadStage']>>[0]) => {
    if (required.conflict) {
      items = [{ ...unattributed, stage: 'won', revision: 2 }];
      return { ok: false as const, error: { code: 'conflict' as const, message: 'Changed', retryable: false } };
    }
    const lead = { ...unattributed, stage: input.request.to, revision: input.request.expectedRevision + 1 };
    return { ok: true as const, value: lead };
  });
  const api = { ...createSampleStudioApi({ runtime: host.runtime }), tool, setLeadStage };
  return { host, api, tool, setLeadStage };
}

it('renders scoped source references, attribution and all five stages', async () => {
  const f = fixture();
  render(<LeadsPage api={f.api} runtime={f.host.runtime} />);
  expect(await screen.findByText('form: submission-1')).toBeTruthy();
  expect(screen.getByText('Unattributed')).toBeTruthy();
  expect(screen.getByText('fixture-ads / fixture-account / paid-campaign')).toBeTruthy();
  expect(screen.getAllByRole('combobox')).toHaveLength(2);
  expect(screen.getAllByRole('option')).toHaveLength(10);
  expect(f.tool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'om_leads_list', input: { query: { page: { limit: 50 } } } }) }));
});

it('changes a stage through the owner API with the displayed expected revision', async () => {
  const f = fixture();
  render(<LeadsPage api={f.api} runtime={f.host.runtime} />);
  const select = await screen.findByLabelText('Stage for submission-1') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'qualified' } });
  await waitFor(() => expect(select.value).toBe('qualified'));
  expect(f.setLeadStage).toHaveBeenCalledOnce();
  expect(f.setLeadStage).toHaveBeenCalledWith(expect.objectContaining({ request: { leadId: 'lead-1', to: 'qualified', expectedRevision: 1, changeId: expect.any(String) } }));
});

it('refetches on a conflict and keeps the authoritative stage', async () => {
  const f = fixture({ conflict: true });
  render(<LeadsPage api={f.api} runtime={f.host.runtime} />);
  fireEvent.change(await screen.findByLabelText('Stage for submission-1'), { target: { value: 'qualified' } });
  await screen.findByText('This lead changed. The inbox has been refreshed.');
  expect(f.tool).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText('Stage for submission-1') as HTMLSelectElement).value).toBe('won');
  expect(f.setLeadStage).toHaveBeenCalledOnce();
});

it('shows an empty inbox, disables erased rows, and rejects malformed tool output', async () => {
  const f = fixture({ items: [] });
  const mounted = render(<LeadsPage api={f.api} runtime={f.host.runtime} />);
  await screen.findByText('No leads yet.');
  mounted.unmount();
  const erased = fixture({ items: [{ ...unattributed, erased: true }] });
  const row = render(<LeadsPage api={erased.api} runtime={erased.host.runtime} />);
  expect((await screen.findByLabelText('Stage for submission-1') as HTMLSelectElement).disabled).toBe(true);
  row.unmount();
  const tool: NonNullable<StudioApiPort['tool']> = async () => ({ ok: true, value: { status: 'completed', output: { items: [{}], cursor: null } } });
  render(<LeadsPage api={{ ...f.api, tool }} runtime={f.host.runtime} />);
  await screen.findByText('Lead inbox unavailable.');
});
