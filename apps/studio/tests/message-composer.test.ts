/** @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfirmationCard, Outcome, ToolCall, ToolResult } from '@open-marketing/contracts';
import { IntegrationsPage } from '../src/pages/addons/index.js';
import { MessageComposer } from '../src/pages/addons/ui/MessageComposer.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);
const connection = { pluginId: 'fixture-messaging', connectionId: 'connection', accountId: 'account', channel: 'sms',
  inboundWebhookUrl: 'https://om.example.test/hooks/agent-plugins/fixture-messaging/connection/account' };
type ToolFn = NonNullable<StudioApiPort['tool']>;
function completed(required: { output: Extract<ToolResult, { status: 'completed' }>['output'] }): Outcome<ToolResult> { return { ok: true, value: { status: 'completed', output: required.output } }; }

function sendCard(required: { operationId: string; input: ToolCall['input'] }): ConfirmationCard {
  return { cardId: 'send-card', operationId: required.operationId, argumentsDigest: 'a'.repeat(64), arguments: { tool: 'om_message_send', input: required.input },
    classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 };
}

it('shows no contact for an unknown phone and never creates one', async () => {
  const host = testRuntime();
  const tool = vi.fn<ToolFn>(async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: 'Subject not found', retryable: false } }));
  render(createElement(MessageComposer, { api: { ...createSampleStudioApi({ runtime: host.runtime }), tool }, runtime: host.runtime, connections: [connection] }));
  fireEvent.change(screen.getByLabelText('Contact phone'), { target: { value: '+15555550199' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find contact' }));
  await screen.findByText('No OM contact for this phone number.');
  expect(tool.mock.calls.map(([input]) => input.call.name)).toEqual(['om_contacts_resolve']);
  expect(tool.mock.calls[0]![0].call.input).toEqual({ identifier: { kind: 'phone', raw: '+15555550199' } });
  await waitFor(() => expect(host.pending()).toBe(0));
});

it('previews segments, sends once with the exact text and maximum, then renders the Allow/Cancel card', async () => {
  const host = testRuntime();
  let card: ConfirmationCard | null = null;
  const tool = vi.fn<ToolFn>(async input => {
    if (input.call.name === 'om_contacts_resolve') return completed({ output: { subjectId: 'subject-1' } });
    if (input.call.name === 'om_message_preview') return completed({ output: { segments: 2 } });
    card = sendCard({ operationId: input.call.operationId, input: input.call.input });
    return { ok: true as const, value: { status: 'pending' as const, operationId: input.call.operationId, cardId: 'send-card' } };
  });
  const approvalCard = vi.fn(async () => ({ ok: true as const, value: card! }));
  const api: StudioApiPort = { ...createSampleStudioApi({ runtime: host.runtime }), tool, approvalCard };
  render(createElement(MessageComposer, { api, runtime: host.runtime, connections: [connection] }));
  fireEvent.change(screen.getByLabelText('Contact phone'), { target: { value: '+15555550100' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find contact' }));
  await screen.findByText('OM contact subject-1');
  const text = 'Spring sale today. Reply STOP to opt out.';
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.blur(screen.getByLabelText('Message'));
  await screen.findByText('2 segments');
  fireEvent.change(screen.getByLabelText('Consent purpose'), { target: { value: 'promotions' } });
  fireEvent.change(screen.getByLabelText('Maximum cost (USD cents)'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  const review = await screen.findByRole('article', { name: 'Review tool call' });
  const sends = tool.mock.calls.filter(([input]) => input.call.name === 'om_message_send');
  expect(sends).toHaveLength(1);
  const call = sends[0]![0].call;
  expect(call.input).toEqual({ operationId: call.operationId, pluginId: 'fixture-messaging', connectionId: 'connection', accountId: 'account', recipient: '+15555550100',
    purpose: 'promotions', intent: 'marketing', message: { content: text }, maxCost: { currency: 'USD', minorUnits: 25 } });
  expect(within(review).getByRole('button', { name: /^Allow$/ })).toBeTruthy();
  expect(within(review).getByRole('button', { name: /^Cancel$/ })).toBeTruthy();
  expect(within(review).queryByRole('button', { name: 'Always allow' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Review and send' }) as HTMLButtonElement).closest('fieldset')!.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  expect(tool.mock.calls.filter(([input]) => input.call.name === 'om_message_send')).toHaveLength(1);
});

it('shows the send tool unavailable reason as-is', async () => {
  const host = testRuntime();
  const tool = vi.fn<ToolFn>(async input => input.call.name === 'om_message_send'
    ? { ok: false as const, error: { code: 'not_implemented' as const, message: 'Local vendor account mode is read-only', retryable: false } }
    : completed({ output: input.call.name === 'om_contacts_resolve' ? { subjectId: 'subject-1' } : { segments: null } }));
  render(createElement(MessageComposer, { api: { ...createSampleStudioApi({ runtime: host.runtime }), tool }, runtime: host.runtime, connections: [connection] }));
  fireEvent.change(screen.getByLabelText('Contact phone'), { target: { value: '+15555550100' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find contact' }));
  await screen.findByText('OM contact subject-1');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
  fireEvent.change(screen.getByLabelText('Consent purpose'), { target: { value: 'notice' } });
  fireEvent.change(screen.getByLabelText('Maximum cost (USD cents)'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
  await screen.findByText('Local vendor account mode is read-only');
  expect(screen.queryByText(/segment/)).toBeNull();
});

it('shows each messaging connection callback URL and copies it', async () => {
  const host = testRuntime();
  const sample = createSampleStudioApi({ runtime: host.runtime });
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const tool = vi.fn<ToolFn>(async () => ({ ok: true as const, value: { status: 'completed' as const, output: { items: [connection, { ...connection, accountId: 'other', inboundWebhookUrl: null }] } } }));
  const api: StudioApiPort = { ...sample, tool, addons: { ...sample.addons!,
    async integrations() { return { ok: true, value: { items: [{ connectionId: 'connection', pluginId: 'fixture-messaging', status: 'saved' }], cursor: null } }; } } };
  render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  await screen.findByText(connection.inboundWebhookUrl);
  expect(screen.getByText('Webhook URL unavailable: set OM_PUBLIC_ORIGIN / bind the account')).toBeTruthy();
  expect(tool.mock.calls.filter(([input]) => input.call.name === 'om_message_connections')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Copy webhook URL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(connection.inboundWebhookUrl));
  await screen.findByText('Webhook URL copied.');
});
