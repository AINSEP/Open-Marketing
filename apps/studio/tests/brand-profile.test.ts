/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ConfirmationCard, ToolCall, ToolOperation } from '@open-marketing/contracts';
import { BrandProfile } from '../src/widgets/workspace-canvas/ui/BrandProfile.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { sampleCards } from '../src/shared/api/sample-data.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);
const kit = { business: { name: 'Fixture studio', facts: ['Owner-operated'] }, offers: [{ name: 'Consultation', facts: ['Thirty minutes'] }],
  audience: { pains: ['Limited time'], goals: ['Clarity'] }, voice: { use: ['Plain language'], avoid: ['Hype'] }, prohibitedClaims: ['Guaranteed results'],
  colours: [{ hex: '#00C896', role: 'accent' }], fonts: [{ family: 'Fixture font', role: 'body' }], logoAssetIds: ['logo-one'], assetIds: ['asset-one'] };

/** Real editor and ApprovalCard, fixture-only port responses, independently controlled ack and completion. */
function fixture() {
  const { runtime } = testRuntime();
  let latest = { revision: 7, status: 'draft' as 'draft' | 'confirmed', at: 1000, kit };
  let confirmed: typeof latest | null = null;
  let writeCall: ToolCall | null = null;
  let result: 'pending' | 'conflict' | 'completed' = 'pending';
  let card: ConfirmationCard = sampleCards({ clock: runtime.clock })[0];
  const tool = vi.fn<NonNullable<StudioApiPort['tool']>>(async ({ call }) => {
    if (call.name === 'om_brand_get') return { ok: true, value: { status: 'completed', output: latest } };
    if (call.name === 'om_brand_confirmed') return { ok: true, value: { status: 'completed', output: confirmed } };
    writeCall = call;
    card = { ...card, cardId: 'brand-card', operationId: call.operationId, classification: 'write', allowedChoices: ['allow', 'cancel'], arguments: { tool: call.name, input: call.input } };
    return { ok: true, value: { status: 'pending', operationId: call.operationId, cardId: card.cardId } };
  });
  const operation = vi.fn<NonNullable<StudioApiPort['operation']>>(async ({ operationId }) => {
    let value: ToolOperation = { status: 'pending', operationId, cardId: card.cardId };
    if (result === 'completed') value = { status: 'completed', operationId, output: latest };
    if (result === 'conflict') value = { status: 'unknown', operationId, error: { code: 'conflict', message: 'Brand revision changed', retryable: false } };
    return { ok: true, value };
  });
  const approve = vi.fn<StudioApiPort['approve']>(async () => ({ ok: true, value: { status: 'recorded' } }));
  const api: StudioApiPort = { ...createSampleStudioApi({ runtime }), tool, operation, approve,
    async approvalCard() { return { ok: true, value: card }; } };
  return { props: { api, runtime, sample: false, onOpenChat: vi.fn() }, tool, operation, approve,
    lastWrite: () => writeCall,
    conflict() { result = 'conflict'; latest = { ...latest, revision: 8, kit: { ...kit, business: { ...kit.business, name: 'Changed elsewhere' } } }; },
    complete() { result = 'completed'; latest = { ...latest, revision: 8, status: 'confirmed' }; confirmed = latest; } };
}

it('saves the loaded expectedRevision and preserves colours, fonts and asset references', async () => {
  const f = fixture(); const user = userEvent.setup(); render(createElement(BrandProfile, f.props));
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Business name' }).value).toBe('Fixture studio'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Business name' }), { target: { value: 'Edited studio' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Business facts' }), { target: { value: 'Owner-operated\nBy appointment' } });
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await screen.findByRole('article', { name: 'Review tool call' });
  expect(f.lastWrite()).toMatchObject({ name: 'om_brand_save_draft', input: { expectedRevision: 7, kit: { ...kit, business: { name: 'Edited studio', facts: ['Owner-operated', 'By appointment'] } } } });
  expect(f.tool.mock.calls.filter(([input]) => input.call.name === 'om_brand_save_draft')).toHaveLength(1);
});

it('keeps typed text on conflict and requires an explicit refresh before another write', async () => {
  const f = fixture(); const user = userEvent.setup(); render(createElement(BrandProfile, f.props));
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Business name' });
  await waitFor(() => expect(name.value).toBe('Fixture studio'));
  fireEvent.change(name, { target: { value: 'Keep my typed text' } });
  await user.click(screen.getByRole('button', { name: 'Save draft' }));
  await user.click(await screen.findByRole('button', { name: 'Allow' }));
  f.conflict();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Brand changed elsewhere. Copy your edits, then Refresh');
  expect(name.value).toBe('Keep my typed text');
  expect(screen.getByRole<HTMLFieldSetElement>('group', { name: 'Business facts and copy guidance' }).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(name.value).toBe('Changed elsewhere'));
  expect(f.tool.mock.calls.filter(([input]) => input.call.name === 'om_brand_save_draft')).toHaveLength(1);
});

it('shows Confirmed only after a completed operation and both reloads, never on card acknowledgement', async () => {
  const f = fixture(); const user = userEvent.setup(); render(createElement(BrandProfile, f.props));
  const confirm = await screen.findByRole('button', { name: 'Confirm revision 7' });
  await user.click(confirm);
  await user.click(await screen.findByRole('button', { name: 'Allow' }));
  await screen.findByText('Choice recorded · awaiting the server action result');
  expect(f.lastWrite()).toMatchObject({ name: 'om_brand_confirm', input: { revision: 7 } });
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Confirmed', { exact: true })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(screen.queryByText('Confirmed', { exact: true })).toBeNull();
  f.complete();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Confirmed', { exact: true });
  expect(screen.getByText('Revision 8 · Fixture studio')).toBeDefined();
  const readNames = f.tool.mock.calls.slice(-2).map(([input]) => input.call.name);
  expect(readNames).toEqual(['om_brand_get', 'om_brand_confirmed']);
});
