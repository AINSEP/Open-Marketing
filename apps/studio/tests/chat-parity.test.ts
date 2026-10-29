/** @vitest-environment jsdom */
/** Written-only parity regressions: published Jini controls + fixture server boundaries. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { AssistantSettingsStatus, AssistantSettings, AssistantUsage } from '@open-marketing/contracts';
import { useOMChatPane, savedMessages } from '../src/widgets/om-chat/OMChatPane.hooks.js';
import { OMChatPane } from '../src/widgets/om-chat/OMChatPane.js';
import { ChatApproval } from '../src/widgets/om-chat/ChatApproval.js';
import { pickerAgents, pickerSelection, runtimeChoice, runtimeInventory, runtimeReadiness, sampleRuntimes } from '../src/widgets/om-chat/runtime.rules.js';
import { approvalSummary } from '../src/widgets/om-chat/approval-summary.rules.js';
import { usageEvents } from '../src/features/chat-run/index.js';
import { conversationUsage, formatUsageCost } from '@jini-ai/chat';
import { testStudio } from './support/studio.js';

afterEach(() => { cleanup(); localStorage.clear(); });

function status(): AssistantSettingsStatus {
  return { settings: { mode: 'model', provider: 'sample-provider-a', model: 'sample-large', connectionId: 'sample-key', effort: 'default' },
    models: sampleRuntimes[0].models, runtimes: [...sampleRuntimes], ready: true, status: 'ready' };
}

it('uses only server choices when connected and only the explicit fixture catalogue in sample mode', () => {
  expect(runtimeInventory({ sample: false, settings: null })).toEqual([]);
  const config = status();
  config.runtimes = [{ ...sampleRuntimes[1], models: [{ id: 'server-model', label: 'Server model', reasoning: [] }], reasoningOptions: [] }];
  const runtimes = runtimeInventory({ sample: false, settings: config });
  expect(runtimes).toEqual(config.runtimes);
  const agents = pickerAgents({ runtimes, selection: { agentId: 'om-model:sample-provider-b', model: 'server-model' } });
  expect(agents[0].models).toEqual([{ id: 'server-model', label: 'Server model', reasoning: [] }]);
  expect(agents[0].reasoningOptions).toEqual([]);
  expect(runtimeInventory({ sample: true, settings: config })).toEqual(sampleRuntimes);
});

it('lists an uploaded provider and saves its exact server ID through the session', async () => {
  const host = testStudio(), writes: AssistantSettings[] = [], config = status();
  config.runtimes = [...sampleRuntimes, { id: 'acme-models', name: 'Acme models', available: true, authStatus: 'ok',
    models: [{ id: 'acme-model', label: 'Acme model', reasoning: [{ id: 'careful', label: 'Careful' }] }], reasoningOptions: [] }];
  host.props.api.settings = async () => ({ ok: true, value: config });
  host.props.api.setSettings = async input => { writes.push(input.settings); return { ok: true, value: { ...config, settings: input.settings } }; };
  try {
    const runtimes = runtimeInventory({ sample: false, settings: config });
    const selection = { agentId: 'om-model:acme-models', model: 'acme-model', reasoning: 'careful' };
    expect(pickerAgents({ runtimes, selection }).find(agent => agent.id === 'om-model:acme-models')).toMatchObject({
      name: 'Acme models', models: [{ id: 'acme-model', label: 'Acme model', reasoning: [{ id: 'careful', label: 'Careful' }] }],
      reasoningOptions: [{ id: 'careful', label: 'Careful' }],
    });
    expect(runtimeChoice({ runtimes, selection })).toEqual({ provider: 'acme-models', model: 'acme-model', effort: 'careful' });
    await host.props.session.refresh();
    await host.props.session.selectRuntime({ provider: 'acme-models', model: 'acme-model', effort: 'careful' });
    expect(writes).toEqual([{ mode: 'model', provider: 'acme-models', model: 'acme-model', effort: 'careful', connectionId: null }]);
    expect(pickerSelection({ settings: host.props.session.getSnapshot().settings, runtimes })).toEqual(selection);
  } finally { host.dispose(); }
});

it('prefixes a provider ID reserved by Jini and maps the selection back to the server ID', () => {
  const runtimes = [{ ...sampleRuntimes[0], id: 'gemini' }];
  const selection = { agentId: 'om-model:gemini', model: 'sample-large', reasoning: 'high' };
  expect(pickerAgents({ runtimes, selection })[0].id).toBe('om-model:gemini');
  expect(runtimeChoice({ runtimes, selection })).toEqual({ provider: 'gemini', model: 'sample-large', effort: 'high' });
});

it('normalizes per-model effort without granting an unadvertised model or vendor', () => {
  const runtimes = sampleRuntimes;
  expect(runtimeChoice({ runtimes, selection: { agentId: 'om-model:sample-provider-a', model: 'sample-small', reasoning: 'max' } })).toEqual({ provider: 'sample-provider-a', model: 'sample-small', effort: 'default' });
  expect(runtimeChoice({ runtimes, selection: { agentId: 'unknown', model: 'sample-large' } })).toBeNull();
  expect(runtimeChoice({ runtimes, selection: { agentId: 'om-model:sample-provider-a', model: 'unadvertised' } })).toBeNull();
  const config = status();
  config.models = [{ id: 'server-model', label: 'Server model' }];
  config.runtimes = [{ ...sampleRuntimes[0], models: config.models, reasoningOptions: [] }];
  config.settings = { ...config.settings, model: 'server-model', effort: undefined };
  expect(pickerSelection({ settings: config, runtimes: runtimeInventory({ sample: false, settings: config }) })).toEqual({ agentId: 'om-model:sample-provider-a', model: 'server-model' });
});

it('does not treat an unsaved fallback or server preview mode as a ready vendor route', () => {
  const config = status(), choice = { provider: 'sample-provider-a' as const, model: 'sample-large', effort: 'default' };
  config.settings.mode = 'sandbox';
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[0], choice }).ready).toBe(false);
  config.settings.mode = 'model';
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[0], choice }).ready).toBe(true);
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[1], choice: { provider: 'sample-provider-b', model: 'sample-balanced' } }).ready).toBe(false);
});

it('renders real model and effort drop-ups in sample mode and never writes preview selections', async () => {
  const host = testStudio(), writes: unknown[] = [];
  host.props.api.setSettings = async input => { writes.push(input); return { ok: true, value: status() }; };
  try {
    const user = userEvent.setup();
    render(createElement(OMChatPane, { ...host.props, sample: true, available: true, open: true, toggle() {} }));
    expect(screen.getByRole('button', { name: 'Agents' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Choose vendor' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Chat history' })).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reasoning: Default' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeDefined();
    expect(writes).toEqual([]);
    expect(screen.queryByText(/coming soon|sandbox/i)).toBeNull();
  } finally { host.dispose(); }
});

it('Escape dismisses the active Jini effort menu before closing the dock', async () => {
  const host = testStudio(); let closes = 0;
  try {
    const user = userEvent.setup();
    render(createElement(OMChatPane, { ...host.props, sample: true, available: true, open: true, toggle() { closes++; } }));
    await user.click(screen.getByRole('button', { name: 'Reasoning: Default' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Reasoning' })).toBeNull();
    expect(closes).toBe(0);
    await user.keyboard('{Escape}'); expect(closes).toBe(1);
  } finally { host.dispose(); }
});

it('persists vendor/model/effort through the existing server write and clears a different vendor key ID', async () => {
  const host = testStudio(), writes: AssistantSettings[] = [];
  host.props.api.settings = async () => ({ ok: true, value: status() });
  host.props.api.setSettings = async input => { writes.push(input.settings); return { ok: true, value: { ...status(), settings: input.settings } }; };
  try {
    await host.props.session.refresh();
    await host.props.session.selectRuntime({ provider: 'sample-provider-b', model: 'sample-balanced', effort: 'high' });
    expect(writes).toEqual([{ mode: 'model', provider: 'sample-provider-b', model: 'sample-balanced', effort: 'high', connectionId: null }]);
    await host.props.session.selectRuntime({ provider: 'sample-provider-b', model: 'unadvertised', effort: 'high' });
    await host.props.session.selectRuntime({ provider: 'sample-provider-b', model: 'sample-balanced', effort: 'max' });
    expect(writes).toHaveLength(1);
  } finally { host.dispose(); }
});

it('blocks overlapping selection writes and run acceptance until the selected runtime is saved', async () => {
  const host = testStudio(), pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<typeof host.props.api.setSettings>>>>();
  let writes = 0, starts = 0;
  host.props.api.settings = async () => ({ ok: true, value: status() });
  host.props.api.setSettings = async () => { writes++; return pending.promise; };
  host.props.api.start = async () => { starts++; return { ok: false, error: { code: 'unavailable', message: 'Fixture', retryable: false } }; };
  try {
    await host.props.session.refresh();
    const selecting = host.props.session.selectRuntime({ provider: 'sample-provider-b', model: 'sample-balanced', effort: 'high' });
    expect(host.props.session.getSnapshot().settingsPending).toBe(true);
    await host.props.session.selectRuntime({ provider: 'sample-provider-c', model: 'sample-fast' });
    await host.props.session.send({ text: 'Do not start with the previous model' });
    expect(writes).toBe(1); expect(starts).toBe(0);
    pending.resolve({ ok: false, error: { code: 'unavailable', message: 'Fixture', retryable: false } }); await selecting;
    expect(host.props.session.getSnapshot().settingsPending).toBe(false);
    expect(host.props.session.getSnapshot().settings?.settings.provider).toBe('sample-provider-a');
  } finally { host.dispose(); }
});

it('keeps unconnected vendors browsable with a connection explanation while sending remains disabled', async () => {
  const host = testStudio(); const config = status();
  config.ready = false; config.status = 'disconnected'; config.runtimes = config.runtimes!.map(item => ({ ...item, available: false, authStatus: 'missing', diagnostic: 'Connect in Integrations' }));
  host.props.api.settings = async () => ({ ok: true, value: config });
  try {
    await host.props.session.refresh();
    const view = renderHook(() => useOMChatPane({ ...host.props, sample: false, available: true, open: true, toggle() {} }));
    expect(view.result.current.pane.agents).toHaveLength(3);
    expect(view.result.current.pane.disabled).toBe(true);
    expect(view.result.current.modeText).toContain('Integrations'); view.unmount();
  } finally { host.dispose(); }
});

it('deduplicates enabled plugin context and removes it without granting any tool authority', async () => {
  const host = testStudio();
  const addon = { id: 'fixture-plugin', kind: 'agent-plugin' as const, name: 'Fixture plugin', description: 'Fixture context', version: '1', revision: '1', enabled: true };
  host.props.api.addons!.list = async () => ({ ok: true, value: { items: [addon], cursor: null } });
  try {
    const view = renderHook(() => useOMChatPane({ ...host.props, sample: true, available: true, open: true, toggle() {} }));
    await act(async () => {});
    const item = view.result.current.pane.composerSlots!.discoveryGroups![0].items[0];
    await act(async () => { await view.result.current.pane.composerSlots!.onDiscoverySelect!({ item, source: 'plus' }); });
    await act(async () => { await view.result.current.pane.composerSlots!.onDiscoverySelect!({ item, source: 'plus' }); });
    expect(view.result.current.selectedPlugins).toHaveLength(1);
    await act(async () => { view.result.current.selectedPlugins[0].remove(); });
    expect(view.result.current.selectedPlugins).toEqual([]); view.unmount();
  } finally { host.dispose(); }
});

it('shows a readable approval before collapsed exact JSON and echoes the original spend identifiers', async () => {
  const host = testStudio(), submitted: unknown[] = [];
  const snapshot = await host.props.api.snapshot({}); if (!snapshot.ok) throw new Error('Fixture unavailable');
  const card = snapshot.value.cards.find(item => item.cardId === 'sample-spend')!;
  host.props.api.approve = async input => { submitted.push(input.response); return { ok: true, value: { status: 'recorded' } }; };
  try {
    const user = userEvent.setup(); const view = render(createElement(ChatApproval, { ...host.props, card, sample: true }));
    expect(view.container.querySelector('.om-chat-approval>header')?.textContent).toContain('spring-ritual');
    const details = view.container.querySelector('details')!; expect(details.open).toBe(false);
    expect(within(details).getByText(/"campaignId"/).textContent).toContain('spring-ritual');
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(submitted).toEqual([{ cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' }]);
    expect(approvalSummary({ card: { ...card, allowedChoices: ['always_allow'] } }).title).toBe('Approval unavailable');
  } finally { host.dispose(); }
});

it('uses Jini prefix totals without inventing zero-cost unknown replies and preserves estimate provenance', () => {
  const first = usageEvents({ usage: { kind: 'usage', costUsdMicros: '70000', durationMs: 8000, costBasis: 'estimated', complete: false } });
  const unknown = usageEvents({ usage: { kind: 'usage', costUsdMicros: '99000000', durationMs: 1000, costBasis: 'unavailable', complete: false } });
  expect(first).toContainEqual({ kind: 'ext', name: 'om.usage-evidence', data: {} });
  expect(unknown[0]).not.toHaveProperty('costUsd');
  const messages = [{ id: 'one', role: 'assistant' as const, content: 'one', events: first }, { id: 'two', role: 'assistant' as const, content: 'two', events: unknown }];
  const totals = conversationUsage({ messages });
  expect(totals.get('one')?.totalCostUsd).toBe(.07);
  expect(totals.get('two')?.costUsd).toBeUndefined();
  expect(formatUsageCost({ costUsd: .07, totalCostUsd: .07 })).toBe('$0.07 · total $0.07');
});

it('confines fabricated timing and prices to sample transcript presentation', () => {
  const host = testStudio();
  try {
    const state = { ...host.props.session.getSnapshot(), messages: [{ id: 'reply', role: 'assistant' as const, text: 'Fixture' }] };
    expect(savedMessages({ state })[0].events).toBeUndefined();
    expect(savedMessages({ state, sample: true })[0].events).toContainEqual({ kind: 'usage', durationMs: 8000, costUsd: .07 });
  } finally { host.dispose(); }
});

/** Exercise the real session transport with fixture server events and usage, never sample hydration. */
function serverUsageFixture(required: { usage: AssistantUsage; cancelled: boolean }) {
  const host = testStudio(), completion = Promise.withResolvers<void>(), usageRequests: string[] = [];
  host.props.api.settings = async () => ({ ok: true, value: status() });
  host.props.api.start = async () => ({ ok: true, value: { runId: 'server-run', mode: 'model', status: 'pending', expiresAt: 61000 } });
  host.props.api.events = async function* () {
    yield { ok: true, value: { protocolVersion: 1, eventId: 'server-text', runId: 'server-run', sequence: 1,
      correlationId: 'correlation', traceId: 'trace', kind: 'delta', payload: { type: 'text_delta', text: 'Server reply' } } };
    await completion.promise;
    yield { ok: true, value: { protocolVersion: 1, eventId: 'server-end', runId: 'server-run', sequence: 2,
      correlationId: 'correlation', traceId: 'trace', kind: required.cancelled ? 'cancelled' : 'ended', payload: { type: 'status', text: 'Terminal' } } };
  };
  host.props.api.runStatus = async ({ runId }) => {
    usageRequests.push(runId);
    return { ok: true, value: { runId, status: required.cancelled ? 'cancelled' : 'completed', usage: required.usage } };
  };
  return { ...host, completion, usageRequests };
}

it.each([
  { name: 'estimated completion', cancelled: false, durationMs: 13000, costBasis: 'estimated', costUsdMicros: '230000', complete: true, line: 'Done · 13s · $0.23 · total $0.23' },
  { name: 'unavailable cost', cancelled: false, durationMs: 21000, costBasis: 'unavailable', complete: false, line: 'Done · 21s' },
  { name: 'partial cancellation', cancelled: true, durationMs: 23000, costBasis: 'estimated', costUsdMicros: '110000', complete: false, line: 'Stopped · 23s · $0.11 · total $0.11' },
] as const)('renders server usage through Jini for $name without sample prices or false success', async scenario => {
  const usage: AssistantUsage = { kind: 'usage', durationMs: scenario.durationMs, costBasis: scenario.costBasis,
    complete: scenario.complete, ...('costUsdMicros' in scenario ? { costUsdMicros: scenario.costUsdMicros } : {}) };
  const host = serverUsageFixture({ usage, cancelled: scenario.cancelled });
  try {
    await host.props.session.refresh();
    const user = userEvent.setup();
    const view = render(createElement(OMChatPane, { ...host.props, sample: false, available: true, open: true, toggle() {} }));
    await user.type(screen.getByPlaceholderText('Ask the assistant to do something…'), 'Report progress');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const reply = (await screen.findByText('Server reply')).closest<HTMLElement>('.jini-message-assistant')!;
    expect(within(reply).queryByRole('button', { name: 'Copy message' })).toBeNull();
    expect(reply.querySelector('.jini-message-usage')).toBeNull();
    await act(async () => { host.completion.resolve(); });
    const line = await screen.findByRole('note');
    const finishedReply = line.closest<HTMLElement>('.jini-message-assistant')!;
    expect(line.textContent?.replace('●', '').trim()).toBe(scenario.line);
    expect(within(finishedReply).getByRole('button', { name: 'Copy message' })).toBeDefined();
    expect(within(finishedReply).getByText('Estimated cost / incomplete usage; totals include reported amounts only.')).toBeDefined();
    expect(host.usageRequests).toEqual(['server-run']);
    expect(host.props.session.getSnapshot().mode).toBe('model');
    expect(host.props.session.getSnapshot().status).toBe(scenario.cancelled ? 'cancelled' : 'complete');
    expect(view.container.textContent).not.toMatch(/Sample timing|\$0\.07/);
    if (scenario.cancelled) expect(line.textContent).not.toContain('Done');
    if (scenario.costBasis === 'unavailable') expect(line.textContent).not.toContain('$');
  } finally { host.completion.resolve(); host.dispose(); }
});

it('a server run keeps streaming while the dock is closed and reopened', async () => {
  const host = serverUsageFixture({ cancelled: false, usage: { kind: 'usage', durationMs: 13000,
    costBasis: 'estimated', costUsdMicros: '230000', complete: true } });
  const start = vi.spyOn(host.props.api, 'start'), cancel = vi.spyOn(host.props.api, 'cancel');
  try {
    await host.props.session.refresh();
    const user = userEvent.setup();
    const props = { ...host.props, sample: false, available: true, open: true, toggle() {} };
    const view = render(createElement(OMChatPane, props));
    await user.type(screen.getByPlaceholderText('Ask the assistant to do something…'), 'Report progress');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Server reply');
    expect(host.props.session.getSnapshot().status).toBe('running');
    view.rerender(createElement(OMChatPane, { ...props, open: false }));
    expect(host.props.session.getSnapshot().status).toBe('running');
    view.rerender(createElement(OMChatPane, props));
    expect(screen.getByText('Server reply')).toBeDefined();
    await act(async () => { host.completion.resolve(); });
    const line = await screen.findByRole('note');
    expect(screen.getAllByRole('note')).toHaveLength(1);
    expect(line.textContent?.replace('●', '').trim()).toBe('Done · 13s · $0.23 · total $0.23');
    expect(screen.getByText('Server reply')).toBeDefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(host.props.session.getSnapshot().status).toBe('complete');
  } finally {
    host.completion.resolve(); host.dispose();
    start.mockRestore(); cancel.mockRestore();
  }
});

it.each(['empty', 'user', 'assistant'] as const)('restores pending cards and surfaces with %s history without mutating session state', async role => {
  const host = testStudio();
  try {
    const snapshot = await host.props.api.snapshot({});
    if (!snapshot.ok) throw new Error('Fixture unavailable');
    const card = snapshot.value.cards[0];
    const surfaces = ['surface', 'second'].map(surfaceId => ({ type: 'a2ui' as const, version: 'v1.0' as const, surfaceId, invocationId: 'invocation-' + surfaceId, runId: 'run', frontendSessionId: 'frontend',
      messages: [{ version: 'v1.0', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Text', text: 'Fixture' }] } }] }));
    const state = { ...host.props.session.getSnapshot(), messages: role === 'empty' ? [] : [{ id: 'message', role, text: 'Fixture' }], cards: [card], surfaces };
    const before = structuredClone(state);
    const messages = savedMessages({ state });
    expect(messages.slice(0, state.messages.length).map(message => message.content)).toEqual(state.messages.map(message => message.text));
    expect(messages.at(-1)?.role).toBe('assistant');
    expect(messages.at(-1)?.events?.filter(event => event.kind === 'ext')).toEqual([
      { kind: 'ext', name: 'om.approval', data: { id: card.cardId } },
      { kind: 'ext', name: 'om.surface', data: { id: 'run:surface' } },
      { kind: 'ext', name: 'om.surface', data: { id: 'run:second' } },
    ]);
    expect(state).toEqual(before);
    expect(savedMessages({ state })).toEqual(messages);
  } finally { host.dispose(); }
});
