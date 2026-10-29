/** Installed model declarations; discovery never reads credentials or executes provider code. */
import { modelProviderSchema } from '@open-marketing/contracts';
import type { AssistantSettings, CallContext, ModelProvider, Outcome } from '@open-marketing/contracts';
import { readAddonCatalog } from './addon-tools.js';
import type { bindServerAddons } from './composition/addons.js';
import { localFailure } from './composition/local-auth.js';

type Provider = { id: string; declaration: ModelProvider };
type AddonReaders = Pick<ReturnType<typeof bindServerAddons>, 'agentPluginState'> & { addons: Pick<ReturnType<typeof bindServerAddons>['addons'], 'list'> };

/** Read current enabled/admitted declarations, isolating corrupt packages; at most 32 runtimes.
 * @example await readModelProviders({ context, addons });
 * @complexity <=1000 catalog rows via existing paging; one state read per candidate until 32 valid.
 */
export async function readModelProviders(required: { context: CallContext; addons?: AddonReaders }): Promise<Outcome<Provider[]>> {
 if (!required.addons) return { ok: true, value: [] };
 const catalog = await readAddonCatalog({ context: required.context, addons: required.addons.addons, kind: 'agent-plugin' });
 if (!catalog.ok) return catalog;
 const providers: Provider[] = [];
 for (const row of catalog.value.filter(row => row.enabled)) {
  const provider = await readProvider({ context: required.context, addons: required.addons, id: row.id });
  if (provider) providers.push(provider);
  if (providers.length === 32) break;
 }
 return { ok: true, value: providers };
}

/** Tainted package errors affect only that package; no raw metadata is exposed in errors/logs. */
async function readProvider(required: { context: CallContext; addons: AddonReaders; id: string }): Promise<Provider | undefined> {
 try {
  const state = await required.addons.agentPluginState({ context: required.context, pluginId: required.id });
  if (!state?.enabled || !state.admitted || !Array.isArray(state.metadata.provides) || !state.metadata.provides.includes('model')) return undefined;
  const declaration = modelProviderSchema.safeParse(state.metadata.modelProvider);
  return declaration.success ? { id: required.id, declaration: declaration.data } : undefined;
 } catch { return undefined; }
}

/** Explicit provider selection, or unique declared model identity for legacy rows. Never choose the first.
 * @example selectedModel({ settings, providers });
 * @complexity O(providers * models), bounded to 32 * 64; pure, typed invalid/unavailable outcomes.
 */
export function selectedModel(required: { settings: AssistantSettings; providers: readonly Provider[] }): Outcome<{ provider: string; declaration: ModelProvider; model: ModelProvider['models'][number] }> {
 const { settings } = required;
 const candidates = required.providers.filter(provider => settings.provider === undefined
  ? provider.declaration.models.some(model => model.id === settings.model) : provider.id === settings.provider);
 if (candidates.length !== 1) return localFailure({ code: 'unavailable', message: 'Model provider unavailable or ambiguous' });
 const provider = candidates[0];
 const model = provider.declaration.models.find(model => model.id === settings.model);
 if (!model || settings.effort !== undefined && !model.efforts.some(effort => effort.id === settings.effort)) {
  return localFailure({ code: 'invalid_input', message: 'Unknown model or effort' });
 }
 return { ok: true, value: { provider: provider.id, declaration: provider.declaration, model } };
}
