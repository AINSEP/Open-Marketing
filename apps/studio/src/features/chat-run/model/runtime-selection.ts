import type { AssistantProvider, AssistantSettings, AssistantSettingsStatus } from '@open-marketing/contracts';

/** Validate against the current server catalogue before saving; no credentials or effects.
 * @complexity O(r+m+e), r <=32, m <=64, e <=8. Invalid selections return null.
 */
export function runtimeSettings(required: { status: AssistantSettingsStatus; provider: AssistantProvider; model: string; effort?: string }): AssistantSettings | null {
  const runtime = required.status.runtimes?.find(item => item.id === required.provider);
  if (!runtime) return null;
  const model = runtime.models.find(item => item.id === required.model);
  if (!model) return null;
  const efforts = model.reasoning ?? runtime.reasoningOptions;
  if (required.effort && !efforts.some(item => item.id === required.effort)) return null;
  return { mode: 'model', provider: required.provider, model: model.id,
    connectionId: required.provider === required.status.settings.provider ? required.status.settings.connectionId : null,
    ...(required.effort ? { effort: required.effort } : {}) };
}
