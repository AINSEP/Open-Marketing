/** @vitest-environment jsdom */
/** Written-only parity regressions: published Jini controls + fixture server boundaries. */
import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { AssistantSettingsStatus, AssistantSettings } from '@open-marketing/contracts';
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
  return { settings: { mode: 'model', provider: 'anthropic', model: 'claude-opus-5-5', connectionId: 'claude-key', effort: 'default' },
    models: sampleRuntimes[0].models, runtimes: [...sampleRuntimes], ready: true, status: 'ready' };
}

it('uses only server choices when connected and only the explicit fixture catalogue in sample mode', () => {
  expect(runtimeInventory({ sample: false, settings: null })).toEqual([]);
  const config = status();
  config.runtimes = [{ ...sampleRuntimes[1], models: [{ id: 'server-model', label: 'Server model', reasoning: [] }], reasoningOptions: [] }];
  const runtimes = runtimeInventory({ sample: false, settings: config });
  expect(runtimes).toEqual(config.runtimes);
  const agents = pickerAgents({ runtimes, selection: { agentId: 'codex', model: 'server-model' } });
  expect(agents[0].models).toEqual([{ id: 'server-model', label: 'Server model', reasoning: [] }]);
  expect(agents[0].reasoningOptions).toEqual([]);
  expect(runtimeInventory({ sample: true, settings: config })).toEqual(sampleRuntimes);
});

it('normalizes per-model effort without granting an unadvertised model or vendor', () => {
  const runtimes = sampleRuntimes;
  expect(runtimeChoice({ runtimes, selection: { agentId: 'claude', model: 'claude-sonnet-5-5', reasoning: 'max' } })).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'default' });
  expect(runtimeChoice({ runtimes, selection: { agentId: 'unknown', model: 'claude-opus-5-5' } })).toBeNull();
  expect(runtimeChoice({ runtimes, selection: { agentId: 'claude', model: 'unadvertised' } })).toBeNull();
  const config = status();
  config.models = [{ id: 'server-model', label: 'Server model' }]; delete config.runtimes;
  config.settings = { ...config.settings, model: 'server-model', effort: undefined };
  expect(pickerSelection({ settings: config, runtimes: runtimeInventory({ sample: false, settings: config }) })).toEqual({ agentId: 'claude', model: 'server-model' });
});

it('does not treat an unsaved fallback or server preview mode as a ready vendor route', () => {
  const config = status(), choice = { provider: 'anthropic' as const, model: 'claude-opus-5-5', effort: 'default' };
  config.settings.mode = 'sandbox';
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[0], choice }).ready).toBe(false);
  config.settings.mode = 'model';
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[0], choice }).ready).toBe(true);
  expect(runtimeReadiness({ sample: false, status: config, selected: sampleRuntimes[1], choice: { provider: 'openai', model: 'gpt-5.2' } }).ready).toBe(false);
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
    await host.props.session.selectRuntime({ provider: 'openai', model: 'gpt-5.2', effort: 'high' });
    expect(writes).toEqual([{ mode: 'model', provider: 'openai', model: 'gpt-5.2', effort: 'high', connectionId: null }]);
    await host.props.session.selectRuntime({ provider: 'openai', model: 'unadvertised', effort: 'high' });
    await host.props.session.selectRuntime({ provider: 'openai', model: 'gpt-5.2', effort: 'max' });
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
    const selecting = host.props.session.selectRuntime({ provider: 'openai', model: 'gpt-5.2', effort: 'high' });
    expect(host.props.session.getSnapshot().settingsPending).toBe(true);
    await host.props.session.selectRuntime({ provider: 'google', model: 'gemini-2.5-flash' });
    await host.props.session.send({ text: 'Do not start with the previous model' });
    expect(writes).toBe(1); expect(starts).toBe(0);
    pending.resolve({ ok: false, error: { code: 'unavailable', message: 'Fixture', retryable: false } }); await selecting;
    expect(host.props.session.getSnapshot().settingsPending).toBe(false);
    expect(host.props.session.getSnapshot().settings?.settings.provider).toBe('anthropic');
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
  const first = usageEvents({ usage: { kind: 'usage', costUsd: .07, durationMs: 8000, costBasis: 'estimated', complete: false } });
  const unknown = usageEvents({ usage: { kind: 'usage', costUsd: 99, durationMs: 1000, costBasis: 'unavailable', complete: false } });
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
