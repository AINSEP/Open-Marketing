/** @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfirmationCard, MeasurementGrant, ToolCall, ToolOperation } from '@open-marketing/contracts';
import { measurementGrantSchema } from '@open-marketing/contracts';
import { ConversionGrants } from '../src/pages/addons/ui/ConversionGrants.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { sampleCards } from '../src/shared/api/sample-data.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);
const grant: MeasurementGrant = { kind: 'measurement', grantId: 'existing', scope: { ownerId: 'owner', workspaceId: 'workspace' },
  connectionId: 'connection', accountId: 'account', definitionIds: ['qualified'], destination: 'fixture-plugin', purpose: 'measurement',
  payloadSchema: 'om.conversion', payloadVersion: 1, expiresAt: 100000, revoked: false };

/** Real panel and ApprovalCard with independently controlled acknowledgement/completion/list replies. */
function fixture() {
  const { runtime } = testRuntime();
  let items = [grant, { ...grant, grantId: 'revoked', revoked: true }, { ...grant, grantId: 'expired', expiresAt: 1 }];
  let call: ToolCall | null = null;
  let state: 'pending' | 'completed' | 'unknown' = 'pending';
  let card: ConfirmationCard = sampleCards({ clock: runtime.clock })[0];
  const list = vi.fn(() => ({ items, cursor: null }));
  const tool = vi.fn<NonNullable<StudioApiPort['tool']>>(async input => {
    if (input.call.name === 'om_measure_grants_list') return { ok: true, value: { status: 'completed', output: list() } };
    call = input.call;
    card = { ...card, cardId: 'sharing-card', operationId: call.operationId, classification: 'write',
      allowedChoices: ['allow', 'cancel'], arguments: { tool: call.name, input: call.input } };
    return { ok: true, value: { status: 'pending', operationId: call.operationId, cardId: card.cardId } };
  });
  const operation = vi.fn<NonNullable<StudioApiPort['operation']>>(async ({ operationId }) => {
    let value: ToolOperation = { status: 'pending', operationId, cardId: card.cardId };
    if (state === 'completed') value = { status: 'completed', operationId, output: {} };
    if (state === 'unknown') value = { status: 'unknown', operationId, error: { code: 'unavailable', message: 'Uncertain', retryable: false } };
    return { ok: true, value };
  });
  const approve = vi.fn<StudioApiPort['approve']>(async () => ({ ok: true, value: { status: 'recorded' } }));
  const api: StudioApiPort = { ...createSampleStudioApi({ runtime }), tool, operation, approve,
    async approvalCard() { return { ok: true, value: card }; } };
  return { props: { api, runtime }, tool, operation, approve, list, lastWrite: () => call,
    complete() {
      state = 'completed';
      if (!call) return;
      if (call.name === 'om_measure_revoke_grant') {
        const { grantId } = measurementGrantSchema.pick({ grantId: true }).parse(call.input);
        items = items.map(item => item.grantId === grantId ? { ...item, revoked: true } : item);
      } else {
        const fields = measurementGrantSchema.omit({ scope: true, kind: true, revoked: true, payloadSchema: true, payloadVersion: true }).parse(call.input);
        items = [...items, { ...grant, ...fields }];
      }
    },
    unresolved() { state = 'unknown'; } };
}

/** Plain bounded inputs; fixed payload metadata and grant identity stay out of the form. */
function fillGrant() {
  fireEvent.change(screen.getByLabelText('Connection ID'), { target: { value: 'connection-new' } });
  fireEvent.change(screen.getByLabelText('Destination plugin ID'), { target: { value: 'fixture-destination' } });
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: 'account-new' } });
  fireEvent.change(screen.getByLabelText('Definition IDs (comma-separated)'), { target: { value: 'qualified, won' } });
  fireEvent.change(screen.getByLabelText('Valid for days'), { target: { value: '2' } });
}

it('lists active, revoked and expired conversion-sharing grants beside bounded inputs', async () => {
  const f = fixture(); render(createElement(ConversionGrants, f.props));
  await screen.findByText('existing · Active');
  expect(screen.getByText('revoked · Revoked')).toBeTruthy();
  expect(screen.getByText('expired · Expired')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Revoke revoked' }).disabled).toBe(true);
  expect(f.tool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'om_measure_grants_list', input: { limit: 100 } }) }));
});

it('keeps grant pending through Allow acknowledgement and reloads only after completed operation lookup', async () => {
  const f = fixture(); render(createElement(ConversionGrants, f.props));
  await screen.findByText('existing · Active'); fillGrant();
  fireEvent.submit(screen.getByRole('form', { name: 'Grant conversion sharing' }));
  await screen.findByRole('article', { name: 'Review tool call' });
  expect(f.lastWrite()).toMatchObject({ name: 'om_measure_grant', input: { grantId: expect.any(String), connectionId: 'connection-new',
    accountId: 'account-new', destination: 'fixture-destination', definitionIds: ['qualified', 'won'], purpose: 'measurement', expiresAt: 1000 + 2 * 86400000 } });
  expect(f.lastWrite()?.input).not.toHaveProperty('scope');
  expect(f.lastWrite()?.input).not.toHaveProperty('payloadSchema');
  expect(f.list).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await screen.findByText('Choice recorded · awaiting the server action result');
  expect(screen.queryByText('Conversion sharing granted.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh grants' }));
  await waitFor(() => expect(f.operation).toHaveBeenCalledTimes(2));
  expect(f.list).toHaveBeenCalledTimes(1);
  f.complete();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh grants' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh grants' }));
  await screen.findByText('Conversion sharing granted.');
  expect(f.list).toHaveBeenCalledTimes(2);
  const written = f.lastWrite()?.input;
  const grantId = measurementGrantSchema.shape.grantId.parse(typeof written === 'object' && written !== null && !Array.isArray(written) ? written.grantId : undefined);
  expect(screen.getByText(grantId + ' · Active')).toBeTruthy();
  expect(f.tool.mock.calls.filter(([input]) => input.call.name === 'om_measure_grant')).toHaveLength(1);
});

it('revokes through the same exact card and shows Revoked only after completion and list reload', async () => {
  const f = fixture(); render(createElement(ConversionGrants, f.props));
  await screen.findByText('existing · Active');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke existing' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
  await screen.findByText('Choice recorded · awaiting the server action result');
  expect(f.lastWrite()).toMatchObject({ name: 'om_measure_revoke_grant', input: { grantId: 'existing' } });
  expect(screen.getByText('existing · Active')).toBeTruthy();
  expect(screen.queryByText('Conversion sharing revoked.')).toBeNull();
  f.complete(); fireEvent.click(screen.getByRole('button', { name: 'Refresh grants' }));
  await screen.findByText('Conversion sharing revoked.');
  expect(screen.getByText('existing · Revoked')).toBeTruthy();
  expect(f.list).toHaveBeenCalledTimes(2);
});

it('retains an unresolved operation and blocks a second grant or revoke', async () => {
  const f = fixture(); render(createElement(ConversionGrants, f.props));
  await screen.findByText('existing · Active'); fillGrant();
  fireEvent.submit(screen.getByRole('form', { name: 'Grant conversion sharing' }));
  await screen.findByRole('article', { name: 'Review tool call' });
  f.unresolved(); fireEvent.click(screen.getByRole('button', { name: 'Refresh grants' }));
  await screen.findByText('Outcome unresolved. Refresh before another submission.');
  fireEvent.submit(screen.getByRole('form', { name: 'Grant conversion sharing' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Revoke existing' }).disabled).toBe(true);
  expect(f.tool.mock.calls.filter(([input]) => input.call.name === 'om_measure_grant')).toHaveLength(1);
  expect(f.list).toHaveBeenCalledTimes(1);
});
