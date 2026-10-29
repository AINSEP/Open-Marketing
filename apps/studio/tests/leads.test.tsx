/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LeadsPage } from '../src/pages/leads/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { fixture, unattributed } from './support/leads.js';

afterEach(cleanup);

function expectQualified(required: { select: HTMLSelectElement }): void {
  expect(required.select.value).toBe('qualified');
}

const malformedTool: NonNullable<StudioApiPort['tool']> = async () => ({ ok: true, value: { status: 'completed', output: { items: [{}], cursor: null } } });

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
  await waitFor(expectQualified.bind(null, { select }));
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
  render(<LeadsPage api={{ ...f.api, tool: malformedTool }} runtime={f.host.runtime} />);
  await screen.findByText('Lead inbox unavailable.');
});
