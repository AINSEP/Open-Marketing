/** OM supplies server state and effects; Jini owns composer, transcript, pickers and display. */
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import type { AgentEvent, ChatMessage as JiniMessage } from '@jini-ai/chat';
import { createExtEventRendererRegistry, useChatSettingsDialog } from '@jini-ai/chat/react';
import type { ChatPermissionsPort, ExtEventRendererRegistry, ExtEventRenderProps, ChatSettingsSection } from '@jini-ai/chat/react';
import type { ChatPaneProps } from '@jini-ai/chat/react/chat-pane';
import { addonListSchema, parseBoundary } from '@open-marketing/contracts';
import type { AddonSummary } from '@open-marketing/contracts';
import { usePortSnapshot } from '../../shared/ui/index.js';
import type { ChatSession, ChatState } from '../../features/chat-run/index.js';
import { usageEvents, sampleReplyUsage } from '../../features/chat-run/index.js';
import type { StudioApiPort, StudioRuntime } from '../../shared/api/index.js';
import { isSafeUiValue } from '../../shared/api/index.js';
import { ChatApproval } from './ChatApproval.js';
import { A2uiSurface } from './A2uiSurface.js';
import { useStudioChartProviders } from '../../features/chart-providers/index.js';
import type { StudioChartHost, ChartProviderRegistry } from '../../features/chart-providers/index.js';
import { useOMChatRuntime } from './OMChatRuntime.hooks.js';
import { useHeaderActionsMenu } from '@jini-ai/ui';

export interface OMChatPaneProps { readonly charts?: { host: StudioChartHost; revision: number | string }; readonly session: ChatSession; readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly sample: boolean; readonly available: boolean; readonly open: boolean; readonly toggle: () => void }
export interface OMChatPaneModel {
  readonly state: ChatState; readonly busy: boolean; readonly pane: ChatPaneProps;
  readonly panelRef: RefObject<HTMLElement | null>; readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly keyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly history: ReturnType<typeof useOMChatHistory>; readonly showAgents: () => void; readonly title: string;
  readonly registry: ExtEventRendererRegistry;
  readonly settings: Omit<ReturnType<typeof useChatSettingsDialog>, 'show'> & { show: () => void };
  readonly displaySections: readonly ChatSettingsSection[];
  readonly selectedPlugins: readonly { id: string; label: string; remove: () => void }[];
  readonly navigationText: string; readonly modeText: string;
}
/** Permission presentation never creates another approval policy. */
export const chatPermissions: ChatPermissionsPort = { enabled: true, canEdit: false, capabilities: [],
  unavailableReason: 'Tool permissions are managed by the server. Spend requires an exact approval every time.', onChange() {} };

/** The dock stays mounted when hidden; focus and display settings are local to this instance.
 * Effects use the existing owner API and cancel stale reads on unmount.
 * @complexity O(messages + add-ons), bounded by the session and one <=100 add-on page.
 */
export function useOMChatPane(required: OMChatPaneProps & { providers?: ChartProviderRegistry }): OMChatPaneModel {
  const state = usePortSnapshot(required.session);
  const panelRef = useRef<HTMLElement>(null), buttonRef = useRef<HTMLButtonElement>(null), wasOpen = useRef(false);
  const [addons, setAddons] = useState<readonly AddonSummary[]>([]);
  const [selected, setSelected] = useState<readonly AddonSummary[]>([]);
  const [toolCallDisplay, setToolCallDisplay] = useState<'show' | 'collapsed' | 'hidden'>('show');
  const dialog = useChatSettingsDialog({});
  const settings = { ...dialog, show: () => dialog.show({}) };
  const registry = useMemo(() => {
    const owned = createExtEventRendererRegistry({});
    registerRenderers({ registry: owned, host: required, providers: required.providers });
    return owned;
  }, [required.api, required.runtime, required.sample, required.session, required.providers]);
  useLayoutEffect(() => registerRenderers({ registry, host: required, providers: required.providers }), [registry, required.api, required.runtime, required.sample, required.session, required.providers]);
  useEffect(() => {
    if (required.open) panelRef.current?.focus();
    if (wasOpen.current && !required.open) buttonRef.current?.focus();
    wasOpen.current = required.open;
  }, [required.open]);
  useEffect(() => { if (required.available && !required.sample) void required.session.refresh(); }, [required.available, required.sample, required.session]);
  useEffect(() => {
    if (!required.api.addons || !required.available) return;
    const controller = required.runtime.abort();
    void required.api.addons.list({ query: { limit: 100 }, signal: controller.signal }).then(result => {
      if (!result.ok || controller.signal.aborted) return;
      const parsed = parseBoundary({ schema: addonListSchema, input: result.value });
      if (parsed.ok && isSafeUiValue({ value: parsed.value, maxCharacters: 262144 })) setAddons(parsed.value.items.filter(addon => addon.enabled));
    });
    return () => controller.abort();
  }, [required.api, required.available, required.runtime]);
  const busy = state.settingsPending || ['starting', 'running', 'cancelling'].includes(state.status);
  const runtime = useOMChatRuntime({ sample: required.sample, state, session: required.session, busy });
  const history = useOMChatHistory({ state, session: required.session, busy });
  const showAgents = (): void => { panelRef.current?.querySelector<HTMLButtonElement>('.jini-runtime-trigger')?.click(); };
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (history.open) { event.stopPropagation(); history.close(); history.containerRef.current?.querySelector('button')?.focus(); return; }
    if (event.currentTarget.querySelector('.jini-runtime-dropup, .jini-composer-discovery-menu, .jini-composer-slash-menu')) return;
    event.stopPropagation(); required.toggle();
  };
  const selectedPlugins = selected.map(addon => ({ id: addon.id, label: addon.name, remove: () => setSelected(current => current.filter(item => item.id !== addon.id)) }));
  const discoveryGroups = [{ id: 'addons', label: 'Enabled add-ons', items: addons.map(addon => ({ id: addon.id, label: addon.name, kind: addon.kind, description: addon.description })) }];
  const onDiscoverySelect: NonNullable<NonNullable<ChatPaneProps['composerSlots']>['onDiscoverySelect']> = ({ item }) => {
    const addon = addons.find(candidate => candidate.id === item.id);
    if (addon) setSelected(current => current.some(candidate => candidate.id === addon.id) ? current : [...current, addon]);
  };
  const toolChoices = (['show', 'collapsed', 'hidden'] as const).map(choice => ({ key: choice, label: choice, checked: toolCallDisplay === choice, change: () => setToolCallDisplay(choice) }));
  const displaySections: ChatSettingsSection[] = [{ key: 'tools', label: 'Tool calls', items: toolChoices.map(choice => ({ ...choice, role: 'menuitemradio', onSelect: choice.change })) }];
  const pane: ChatPaneProps = {
    transport: required.session.transport, initialMessages: savedMessages({ state, sample: required.sample }), conversationId: state.conversationId,
    agents: runtime.agents, selection: runtime.selection, onSelectionChange: runtime.change,
    workingDirectoryControlPlacement: 'none', agentPluginsMode: 'off',
    disabled: !required.available || !runtime.ready || state.settingsPending,
    placeholder: 'Ask the assistant to do something…', toolCallDisplay, showUsageLine: true,
    runContext: () => ({ pluginInstructions: selected.map(addon => addon.name + ' (' + addon.id + ')') }),
    composerSlots: { discoveryGroups, onDiscoverySelect },
  };
  return { state, busy, pane, panelRef, buttonRef, keyDown, history, showAgents, registry, settings, displaySections, selectedPlugins,
    title: state.conversations.find(item => item.conversationId === state.conversationId)?.title || state.messages.find(item => item.role === 'user')?.text.slice(0, 80) || 'New chat',
    navigationText: navigationText({ state }), modeText: state.notice === 'Assistant selection could not be saved.' ? state.notice : runtime.notice };
}

/** Adapt existing session actions to Jini's menu lifecycle; unsupported rename/delete are omitted. */
function useOMChatHistory(required: { state: ChatState; session: ChatSession; busy: boolean }) {
  const menu = useHeaderActionsMenu([]);
  useLayoutEffect(() => { if (menu.open) menu.containerRef.current?.querySelector<HTMLElement>('[role="dialog"] button')?.focus(); }, [menu.open, menu.containerRef]);
  const select = (input: { conversationId: string }): void => { if (required.busy) return; menu.close(); void required.session.selectConversation(input); };
  const create = (): void => { if (required.busy) return; menu.close(); void required.session.newConversation(); };
  const items = required.state.conversations.map(item => ({ id: item.conversationId, label: item.title || 'Untitled',
    selected: item.conversationId === required.state.conversationId, onClick: () => select({ conversationId: item.conversationId }) }));
  return { ...menu, items, create };
}
/** Share the existing chart host, including its table fallback, across every surface. */
export function usePluginOMChatPane(required: OMChatPaneProps & { charts: NonNullable<OMChatPaneProps['charts']> }): OMChatPaneModel {
  const snapshot = useStudioChartProviders(required.charts);
  return useOMChatPane({ ...required, providers: snapshot.providers });
}
/** Convert validated history to Jini, including pending slots even before any assistant text.
 * Returns a fresh presentation transcript; session history and authority are unchanged.
 * @example savedMessages({ state, sample: false })
 * @complexity O(messages + cards + surfaces) time/space, bounded to 200/50/20 retained items.
 */
export function savedMessages(required: { state: ChatState; sample?: boolean }): JiniMessage[] {
  const messages = required.state.messages.map<JiniMessage>(message => ({ id: message.id, role: message.role, content: message.text,
    createdAt: message.createdAt, startedAt: message.startedAt, endedAt: message.endedAt,
    events: required.sample ? sampleUsage({ sample: true, message }) : message.usage ? [{ kind: 'text', text: message.text }, ...usageEvents({ usage: message.usage })] : undefined }));
  const slots: AgentEvent[] = [...required.state.cards.map(card => ({ kind: 'ext' as const, name: 'om.approval', data: { id: card.cardId } })),
    ...required.state.surfaces.map(surface => ({ kind: 'ext' as const, name: 'om.surface', data: { id: surface.runId + ':' + surface.surfaceId } }))];
  if (!slots.length) return messages;
  const last = messages.findLast(message => message.role === 'assistant');
  if (!last) return [...messages, { id: 'om-extensions', role: 'assistant', content: '', events: slots }];
  last.events = [...(last.events ?? [{ kind: 'text', text: last.content }]), ...slots];
  return messages;
}
/** Sample presentation evidence is confined to sample mode; it never enters a server request. */
function sampleUsage(required: { sample?: boolean; message: { role: string; text: string } }): AgentEvent[] | undefined {
  if (!required.sample || required.message.role !== 'assistant') return undefined;
  return [{ kind: 'text', text: required.message.text }, ...usageEvents({ usage: sampleReplyUsage, sample: true })];
}
/** Slot identities are generated from already-validated session state, never used as authority. */
export function slotIdentity(required: { data: unknown }): string | undefined {
  if (typeof required.data !== 'object' || required.data === null || !('id' in required.data)) return undefined;
  return typeof required.data.id === 'string' ? required.data.id : undefined;
}
function ApprovalSlot(required: { render: ExtEventRenderProps; host: OMChatPaneProps }) {
  const state = usePortSnapshot(required.host.session);
  const card = state.cards.find(item => item.cardId === slotIdentity({ data: required.render.events.at(-1) }));
  return card ? createElement(ChatApproval, { card, api: required.host.api, runtime: required.host.runtime, sample: required.host.sample }) : null;
}
function SurfaceSlot(required: { render: ExtEventRenderProps; host: OMChatPaneProps; providers?: ChartProviderRegistry }) {
  const state = usePortSnapshot(required.host.session);
  const surface = state.surfaces.find(item => item.runId + ':' + item.surfaceId === slotIdentity({ data: required.render.events.at(-1) }));
  return surface ? createElement(A2uiSurface, { surface, api: required.host.api, runtime: required.host.runtime, providers: required.providers,
    streaming: required.render.runStreaming, succeeded: required.render.runSucceeded, onPendingApproval: required.host.session.addSurfaceApproval }) : null;
}
function navigationText(required: { state: ChatState }): string {
  const result = required.state.navigation;
  if (!result) return '';
  if (result.status === 'completed') return 'Opened ' + result.target + ' in this browser.';
  if (result.status === 'failed') return 'Navigation failed: ' + result.error.message;
  return 'Navigation pending browser acknowledgement.';
}

/** Creation-time registration makes the first memoized MessageRow see its slots. Layout-effect
 * setup replaces these entries and owns cleanup, including React StrictMode effect replay.
 */
function registerRenderers(required: { registry: ExtEventRendererRegistry; host: OMChatPaneProps; providers?: ChartProviderRegistry }): () => void {
  const dispose = [required.registry.register({ name: 'om.approval', renderer: render => createElement(ApprovalSlot, { render, host: required.host }) }, { slotKey: slotIdentity }),
    required.registry.register({ name: 'om.usage-evidence', renderer: () => createElement('small', { className: 'om-usage-evidence' }, 'Estimated cost / incomplete usage; totals include reported amounts only.') }),
    required.registry.register({ name: 'om.sample-usage', renderer: () => createElement('small', { className: 'om-usage-evidence' }, 'Sample timing and cost · no vendor call') }),
    required.registry.register({ name: 'om.surface', renderer: render => createElement(SurfaceSlot, { render, host: required.host, providers: required.providers }) }, { slotKey: slotIdentity })];
  return () => { dispose.forEach(unregister => unregister()); };
}
