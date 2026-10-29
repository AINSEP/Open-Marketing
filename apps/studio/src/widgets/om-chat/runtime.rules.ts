/** Server DTO -> published Jini inventory adapter. No vendor effects or credentials live here. */
import type { ChatPaneAgent, ChatPaneAgentSelection } from '@jini-ai/chat/react/chat-pane';
import type { I18nAdapter } from '@jini-ai/chat/react';
import type { AssistantSettingsStatus } from '@open-marketing/contracts';

const pickerPrefix = 'om-model:';
export type Runtime = NonNullable<AssistantSettingsStatus['runtimes']>[number];

/** Explicit preview inventory only; connected mode always reads the server catalogue. */
export const sampleRuntimes: readonly Runtime[] = [
  { id: 'sample-provider-a', name: 'Sample provider A', available: true, authStatus: 'ok', models: [
    { id: 'sample-large', label: 'Sample Large', reasoning: [{ id: 'default', label: 'Default' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }] },
    { id: 'sample-small', label: 'Sample Small', reasoning: [{ id: 'default', label: 'Default' }, { id: 'high', label: 'High' }] },
  ], reasoningOptions: [] },
  { id: 'sample-provider-b', name: 'Sample provider B', available: true, authStatus: 'ok', models: [
    { id: 'sample-balanced', label: 'Sample Balanced', reasoning: [{ id: 'default', label: 'Default' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }] },
  ], reasoningOptions: [] },
  { id: 'sample-provider-c', name: 'Sample provider C', available: true, authStatus: 'ok', models: [
    { id: 'sample-fast', label: 'Sample Fast', reasoning: [{ id: 'default', label: 'Default' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
  ], reasoningOptions: [] },
];

/** Connected inventory comes only from the server's advertised runtimes. */
export function runtimeInventory(required: { sample: boolean; settings: AssistantSettingsStatus | null }): readonly Runtime[] {
  return required.sample ? sampleRuntimes : required.settings?.runtimes ?? [];
}

/** Use Jini's inventory picker for server selections; availability gates sending, not browsing.
 * @complexity O(r*m), r <=32 providers and m <=64 models per server DTO. Pure, no failures/effects.
 */
export function pickerAgents(required: { runtimes: readonly Runtime[]; selection: ChatPaneAgentSelection }): ChatPaneAgent[] {
  return required.runtimes.map(runtime => ({ id: pickerPrefix + runtime.id, name: runtime.name,
    available: true, authStatus: runtime.authStatus, diagnostic: runtime.available ? undefined : 'Connect in Integrations',
    models: runtime.models, reasoningOptions: runtime.models.find(model => model.id === required.selection.model)?.reasoning ?? runtime.reasoningOptions }));
}

/** Only an advertised provider/model/effort becomes a server settings request. */
export function runtimeChoice(required: { selection: ChatPaneAgentSelection; runtimes: readonly Runtime[] }) {
  const runtime = required.runtimes.find(item => pickerPrefix + item.id === required.selection.agentId);
  const model = runtime?.models.find(item => item.id === required.selection.model);
  if (!runtime || !model) return null;
  const efforts = model.reasoning ?? runtime.reasoningOptions;
  const effort = efforts.find(item => item.id === required.selection.reasoning)?.id ?? efforts[0]?.id;
  return { provider: runtime.id, model: model.id, ...(effort ? { effort } : {}) };
}

/** Map server-owned settings into Jini's controlled, data-only selection. */
export function pickerSelection(required: { settings: AssistantSettingsStatus | null; runtimes: readonly Runtime[] }): ChatPaneAgentSelection {
  const provider = required.settings?.settings.provider ?? required.runtimes[0]?.id;
  const runtime = required.runtimes.find(item => item.id === provider) ?? required.runtimes[0];
  const model = runtime?.models.find(item => item.id === required.settings?.settings.model) ?? runtime?.models[0];
  const efforts = model?.reasoning ?? runtime?.reasoningOptions ?? [];
  const reasoning = efforts.find(item => item.id === required.settings?.settings.effort)?.id ?? efforts[0]?.id;
  return { agentId: runtime ? pickerPrefix + runtime.id : '', ...(model ? { model: model.id } : {}), ...(reasoning ? { reasoning } : {}) };
}

/** A displayed fallback is not a persisted choice, and preview mode never implies vendor routing. */
export function runtimeReadiness(required: { sample: boolean; status: AssistantSettingsStatus | null; selected?: Runtime; choice: ReturnType<typeof runtimeChoice> }) {
  if (required.sample) return { ready: true, notice: 'Sample · no vendor calls' };
  if (!required.selected?.available || !required.status?.ready) return { ready: false, notice: 'Connect this vendor in Integrations.' };
  const configured = required.status.settings;
  const matches = required.choice?.provider === configured.provider && required.choice?.model === configured.model;
  if (!matches || configured.mode !== 'model') return { ready: false, notice: 'Select a model to start chatting.' };
  return { ready: true, notice: '' };
}

/** Removable 0.6.12 vocabulary adapter: its inventory mode says CLI; OM only has server runtimes.
 * Remove with the matching CSS rule when Jini exposes API inventory + model/effort bar menus.
 * Jini retains all picker/drop-up behavior; no execution mode is forwarded to OM's transport.
 */
export const serverPickerI18n: I18nAdapter = { locale: 'en', t(key, vars) {
  const labels: Record<string, string> = { 'Local CLI': 'Server models', 'Code agent': 'Vendor', 'Choose AI runtime': 'Choose vendor',
    'Installed · sign-in required': 'Connect in Integrations', Installed: 'Connected', 'Offline fallback': 'Server catalogue',
    'No available code agents': 'Connect a vendor in Integrations', 'No usable CLI is selected.': 'Choose a server model in Integrations.' };
  let label = labels[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) label = label.replaceAll('{' + name + '}', String(value));
  return label;
} };
