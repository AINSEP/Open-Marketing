/** Secure owner form state. Tokens never enter snapshots, messages, or local storage. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, FormEvent, MouseEvent, SetStateAction } from 'react';
import { setConversionSettingsSchema, connectIntegrationTokenSchema, pluginSecretSetSchema } from '@open-marketing/contracts';
import type { z } from 'zod';
import { oauthClientSetSchema, oauthChallengeSchema } from '../../../shared/api/index.js';
import type { OAuthStatus } from '../../../shared/api/index.js';
import type { ConversionSettingsDeclaration, ConversionSettingsStatus, ConversionSettingsValues, AddonSummary, CredentialCard, ConfirmationCard, IntegrationSummary, MailProviderSettings, ToolOperation, ToolResult } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

export interface IntegrationsPageProps { api: StudioApiPort; runtime: StudioRuntime }
/** Owner mail selection; server acknowledgements alone update saved state. No write retries.
 * @example useMailProvider({ api, runtime });
 * @complexity O(c) render time/space for c <=1000 candidates; one bounded request per action.
 */
export function useMailProvider(required: IntegrationsPageProps) {
  const [settings, setSettings] = useState<MailProviderSettings | null>(null);
  const [selected, setSelected] = useState('');
  const [alertFrom, setAlertFrom] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const failure = 'Mail provider could not be confirmed. Refresh before resubmitting.';
  /** A failed refresh invalidates settings so saving requires a successful read. */
  const load = async (): Promise<void> => {
    setSettings(null);
    const signal = controller.current?.signal;
    const result = await required.api.addons?.mailProviderSettings({ signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setStatus(failure); return; }
    setSettings(result.value); setSelected(result.value.selected ?? ''); setAlertFrom(result.value.alertFrom ?? '');
  };
  /** POST both settings once, then apply the ack or restore the last confirmed values. */
  const saveSelection = async (): Promise<void> => {
    if (!settings) return;
    const signal = controller.current?.signal;
    const result = await required.api.addons?.setMailProviderSettings({ request: { selected: selected || null, alertFrom: alertFrom.trim() || null }, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setSelected(settings.selected ?? ''); setAlertFrom(settings.alertFrom ?? ''); setStatus(failure); return; }
    const saved = { ...settings, ...result.value };
    setSettings(saved); setSelected(saved.selected ?? ''); setAlertFrom(saved.alertFrom ?? ''); setStatus('Mail provider saved.');
  };
  /** Serialize actions and suppress late replies after teardown using the existing runtime abort seam. */
  const perform = async (input: { work: () => Promise<void> }): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setStatus('');
    const signal = controller.current?.signal;
    try { await input.work(); }
    catch { if (!signal?.aborted) { setSelected(settings?.selected ?? ''); setAlertFrom(settings?.alertFrom ?? ''); setStatus(failure); } }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => { const active = required.runtime.abort(); controller.current = active; lock.current = false; void perform({ work: load }); return () => active.abort(); }, [required.api, required.runtime]);
  /** Native select ABI; values remain local until an explicit save. */
  const change = (event: ChangeEvent<HTMLSelectElement>): void => { setSelected(event.currentTarget.value); };
  /** Native email ABI; the shared API schema validates before any request. */
  const changeFrom = (event: ChangeEvent<HTMLInputElement>): void => { setAlertFrom(event.currentTarget.value); };
  /** Clearing is a draft edit; Save persists null to restore the plugin default. */
  const resetFrom = (): void => { setAlertFrom(''); };
  const save = (): void => { void perform({ work: saveSelection }); };
  const refresh = (): void => { void perform({ work: load }); };
  return { settings, selected, alertFrom, status, busy, change, changeFrom, resetFrom, save, refresh,
    stale: settings?.selected && !settings.candidates.some(row => row.pluginId === settings.selected) };
}
export interface ConnectionRowProps { connection: IntegrationSummary; label: string; busy: boolean; disconnect(required: { connectionId: string }): Promise<void> }
/** Private forms and connection management. Read one installed-plugin page (<=100), including disabled rows.
 * Each plugin reads its own cards; HTTP deadlines bound this accepted N+1 discovery. @example useIntegrations({ api, runtime }); */
export function useIntegrations(required: IntegrationsPageProps) {
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<Pick<AddonSummary, 'id' | 'name'>[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(false);
  const readEpoch = useRef(0);
  const load = async (input: { cursor?: string; signal?: AbortSignal } = {}): Promise<void> => {
    const epoch = ++readEpoch.current;
    setLoading(true);
    try {
      if (!required.api.addons) { setPlugins([]); setError('Integrations are unavailable on this server.'); return; }
      const [result, installed] = await Promise.all([
        required.api.addons.integrations({ query: { limit: 100, cursor: input.cursor }, signal: input.signal }),
        required.api.addons.list({ query: { kind: 'agent-plugin', limit: 100 }, signal: input.signal }),
      ]);
      if (!mounted.current || input.signal?.aborted || epoch !== readEpoch.current) return;
      if (!installed.ok) { setPlugins([]); setError('Integrations could not be loaded.'); return; }
      setPlugins(installed.value.items.map(row => ({ id: row.id, name: row.name })));
      if (!result.ok) { setError('Connections could not be loaded.'); return; }
      setItems(result.value.items); setCursor(result.value.cursor);
    } catch { if (mounted.current) { setPlugins([]); setError('Integrations could not be loaded.'); } }
    finally { if (mounted.current && epoch === readEpoch.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = required.runtime.abort();
    void load({ signal: controller.signal });
    return () => { mounted.current = false; readEpoch.current++; controller.abort(); };
  }, [required.api, required.runtime]);
  const submitFor = (input: { pluginId: string; card: CredentialCard }) => async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    const form = readCardForm({ event, card: input.card });
    if (lock.current) return;
    const plaintext = connectionPlaintext({ card: input.card, values: form.values });
    const request = connectIntegrationTokenSchema.safeParse({ pluginId: input.pluginId, connectionId: form.connectionId || required.runtime.ids.next({}), plaintext });
    setError(''); setNotice('');
    if (!request.success) { setError('Enter valid credentials and whole-number integer fields.'); return; }
    if (!required.api.addons) { setError('Integrations are unavailable on this server.'); return; }
    lock.current = true; setBusy(true);
    try {
      const result = await required.api.addons.connect({ request: request.data });
      if (!mounted.current) return;
      if (!result.ok) { setError('Connection could not be saved. Refresh before another submission.'); return; }
      setNotice('Saved on the server.'); await load();
    } catch { if (mounted.current) setError('Response unavailable. Refresh before another submission.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const disconnect = async (input: { connectionId: string }): Promise<void> => {
    if (lock.current || !required.api.addons) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await required.api.addons.disconnect({ request: input });
      if (!mounted.current) return;
      if (!result.ok) { setError('Disconnect response unavailable. Refresh before another submission.'); return; }
      setNotice('Disconnected.'); await load();
    } catch { if (mounted.current) setError('Response unavailable. Refresh before another submission.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const refresh = (): void => { setError(''); void load(); };
  const next = (): void => { if (cursor) void load({ cursor }); };
  return { pluginRows: plugins.map(plugin => ({ ...required, pluginId: plugin.id, label: plugin.name, connections: items, submitFor, busy: busy || loading })), items, busy: busy || loading, error, notice, refresh, next, cursor,
    rows: items.map(connection => ({ connection, label: plugins.find(plugin => plugin.id === connection.pluginId)?.name ?? connection.pluginId, busy: busy || loading, disconnect })) };
}
/** Connection row binding and labels are presentation-only; saved does not claim verification. */
export function useConnectionRow(required: ConnectionRowProps) {
  const labels = { saved: 'Saved', reconnect_required: 'Reconnect required', disconnected: 'Disconnected' };
  return { label: required.label, status: labels[required.connection.status],
    disconnect: () => { void required.disconnect({ connectionId: required.connection.connectionId }); } };
}
export interface OAuthVendorProps extends IntegrationsPageProps {
  pluginId: string; label: string; connections: readonly IntegrationSummary[];
  submitFor: ReturnType<typeof useIntegrations>['pluginRows'][number]['submitFor']; busy: boolean;
}

/** Cards, private client configuration and the existing cancellable, policy-owned sign-in lifecycle.
 * O(cards × fields + connections), <=32 cards/16 fields/100 connections; 15s HTTP deadlines, no retries. */
export function useOAuthVendor(required: OAuthVendorProps) {
  const [cards, setCards] = useState<CredentialCard[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [guidance, setGuidance] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<ConfirmationCard | null>(null);
  const [challenge, setChallenge] = useState<z.infer<typeof oauthChallengeSchema> | null>(null);
  const operationId = useRef<string | null>(null);
  const pendingCardId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const expiry = useRef<unknown>(null);
  /** Replace the active expiry timer; an elapsed deadline schedules the same callback immediately. */
  const scheduleExpiry = (input: { expiresAt: number; onExpire: () => void }): void => {
    required.runtime.timers.cancel({ handle: expiry.current });
    expiry.current = required.runtime.timers.schedule({ delayMs: Math.max(0, input.expiresAt - required.runtime.clock.now({})), callback: input.onExpire });
  };
  const acceptChallenge = (input: { output: unknown }): void => {
    const parsed = oauthChallengeSchema.safeParse(input.output);
    if (!parsed.success || parsed.data.expiresAt <= required.runtime.clock.now({})) { operationId.current = null; setCard(null); setError('Sign-in link unavailable or expired. Start a new sign-in.'); return; }
    setCard(null); setChallenge(parsed.data); setNotice('Sign-in pending. Open the secure sign-in link.');
    scheduleExpiry({ expiresAt: parsed.data.expiresAt, onExpire: () => {
      setChallenge(null); operationId.current = null; setNotice('Sign-in expired. Start again.');
    } });
  };
  const readStatus = async (): Promise<void> => {
    const signal = controller.current?.signal;
    if (!required.api.addons) { setError('Sign-in status unavailable.'); return; }
    const query = challenge ? { transactionId: challenge.transactionId } : { pluginId: required.pluginId };
    const result = await required.api.addons.oauthStatus({ query, signal });
    if (signal?.aborted) return;
    if (!result.ok) { setError('Sign-in status unavailable. Refresh before another submission.'); return; }
    applyOAuthStatus({ status: result.value, setConfigured, setGuidance, setNotice, setCards });
    if ('status' in result.value && result.value.status !== 'pending') {
      setChallenge(null); operationId.current = null; required.runtime.timers.cancel({ handle: expiry.current });
    }
  };
  const perform = async (input: { work: () => Promise<void> }): Promise<void> => {
    if (lock.current || controller.current?.signal.aborted) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true); setError('');
    try { await input.work(); }
    catch { if (!signal?.aborted) setError('Response unavailable. Refresh before another submission.'); }
    finally { if (!signal?.aborted) lock.current = false; if (!signal?.aborted) setBusy(false); }
  };
  /** Fetch/recover the same receipt's card; a failed read preserves its identity for the next check. */
  const readApproval = async (input: { id: string; cardId: string }): Promise<void> => {
    pendingCardId.current = input.cardId;
    const signal = controller.current?.signal;
    const pending = await required.api.approvalCard?.({ cardId: input.cardId, signal });
    if (signal?.aborted) return;
    if (!pending?.ok) { setError('Sign-in approval unavailable. Check sign-in status to try loading it again.'); return; }
    if (pending.value.operationId !== input.id || pending.value.cardId !== input.cardId) { setCard(null); setError('Sign-in approval identity mismatch.'); return; }
    setCard(pending.value); setNotice('Review the sign-in request, then check sign-in status.');
    scheduleExpiry({ expiresAt: pending.value.expiresAt, onExpire: () => {
      setCard(null); setNotice('Sign-in approval expired. Check status before starting again.');
    } });
  };
  /** Check any supplied identity before applying UI transitions; unknown outcomes retain the operation.
   * @complexity O(1) time/space, at most one identity-checked approval read; no write retries.
   */
  const applyOperation = async (input: { id: string; value: ToolResult | ToolOperation }): Promise<void> => {
    if ('operationId' in input.value && input.value.operationId !== input.id) { setError('Sign-in operation identity mismatch.'); return; }
    if (input.value.status === 'completed') { acceptChallenge({ output: input.value.output }); return; }
    if (input.value.status === 'pending') {
      const cardId = input.value.cardId ?? pendingCardId.current;
      if (cardId) { await readApproval({ id: input.id, cardId }); return; }
      setNotice('Awaiting sign-in outcome.'); return;
    }
    setCard(null); required.runtime.timers.cancel({ handle: expiry.current });
    if (input.value.status === 'unknown') { setNotice('Sign-in outcome unresolved. Check status again before starting another sign-in.'); return; }
    operationId.current = null; pendingCardId.current = null; setNotice('Sign-in did not complete. Start again.');
  };
  const readOperation = async (input: { id: string }): Promise<void> => {
    const signal = controller.current?.signal;
    const result = await required.api.operation?.({ operationId: input.id, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Sign-in operation unavailable.'); return; }
    await applyOperation({ id: input.id, value: result.value });
  };
  const refresh = (): void => { void perform({ work: async () => {
    if (operationId.current && !challenge) {
      await readOperation({ id: operationId.current }); return;
    }
    await readStatus();
  } }); };
  useEffect(() => {
    const active = required.runtime.abort(); controller.current = active; lock.current = false;
    void perform({ work: readStatus });
    return () => { active.abort(); required.runtime.timers.cancel({ handle: expiry.current }); };
  }, [required.api, required.runtime, required.pluginId]);
  /** Save and clear share one private ingress; fixed notices never reflect supplied fields. */
  const setClient = (input: { client: unknown }): void => { void perform({ work: async () => {
    const signal = controller.current?.signal;
    const request = oauthClientSetSchema.safeParse({ pluginId: required.pluginId, client: input.client });
    if (!request.success) { setError('Enter a client ID and valid client configuration.'); return; }
    const result = await required.api.addons?.setOAuthClient({ request: request.data, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Client configuration could not be confirmed. Refresh before resubmitting.'); return; }
    setConfigured(result.value.configured); setNotice(result.value.configured ? 'Client configured on the server. Sign-in is a separate step.' : 'Client configuration cleared.');
  } }); };
  const saveClientFor = (input: { card: CredentialCard }) => (event: FormEvent<HTMLFormElement>): void => { setClient({ client: readCardForm({ event, card: input.card }).values }); };
  const clearClient = (event: MouseEvent<HTMLButtonElement>): void => { event.currentTarget.form?.reset(); setClient({ client: null }); };
  const signIn = (): void => {
    if (operationId.current) return;
    void perform({ work: async () => {
    const signal = controller.current?.signal;
    setChallenge(null); setCard(null); required.runtime.timers.cancel({ handle: expiry.current });
    const id = required.runtime.ids.next({}); operationId.current = id; pendingCardId.current = null;
    const result = await required.api.tool?.({ call: { name: 'integrations_oauth_start', operationId: id, input: { pluginId: required.pluginId } }, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Sign-in could not be confirmed. Check status before starting again.'); return; }
    await applyOperation({ id, value: result.value });
  } }); };
  return { notice, error, connectionStatus: vendorStatus({ connections: required.connections, pluginId: required.pluginId }),
    cardRows: cards.map(credential => ({ ...required, credential, configured, guidance, busy: busy || required.busy, card, challenge,
      awaitingOperation: operationId.current !== null, saveClient: saveClientFor({ card: credential }), clearClient, signIn, refresh,
      submitConnection: required.submitFor({ pluginId: required.pluginId, card: credential }), fields: cardFields({ card: credential, busy: busy || required.busy }),
    })),
  };
}
export type PluginCardRow = ReturnType<typeof useOAuthVendor>['cardRows'][number];
/** Configuration and saved account status remain separate; neither claims a working vendor connection. */
function applyOAuthStatus(required: { status: OAuthStatus; setConfigured: Dispatch<SetStateAction<boolean | null>>; setGuidance: Dispatch<SetStateAction<string>>; setNotice: Dispatch<SetStateAction<string>>; setCards: Dispatch<SetStateAction<CredentialCard[]>> }): void {
  if ('credentialCards' in required.status) required.setCards(required.status.credentialCards);
  if ('configured' in required.status) { required.setConfigured(required.status.configured); required.setGuidance(required.status.guidance ?? ''); return; }
  const labels = { pending: 'Sign-in pending.', complete: 'Sign-in saved on the server.', expired: 'Sign-in expired. Start again.' };
  required.setNotice(required.status.connection?.status === 'reconnect_required' ? 'Reconnect required.' : labels[required.status.status]);
}
function vendorStatus(required: { connections: readonly IntegrationSummary[]; pluginId: string }): string {
  const rows = required.connections.filter(row => row.pluginId === required.pluginId);
  if (rows.some(row => row.status === 'reconnect_required')) return 'Reconnect required';
  if (rows.some(row => row.status === 'saved')) return 'Sign-in or token saved';
  return 'No connection saved';
}

/** Plugin-scoped secret form; only boolean status survives a call. O(f), <=16 declared fields, no retries. */
export function usePluginSecret(required: IntegrationsPageProps & { pluginId: string; card: CredentialCard }) {
  const [status, setStatus] = useState('Status unavailable');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  /** Both operations use the same lock, cancellation and fixed-error boundary; never retain field values. */
  const perform = async (input: { request?: import('@open-marketing/contracts').PluginSecretSet }): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    const signal = controller.current?.signal;
    const failure = input.request ? 'Save unconfirmed. Refresh before resubmitting.' : 'Status unavailable';
    try {
      const result = input.request ? await required.api.addons?.setPluginSecret({ request: input.request, signal }) : await required.api.addons?.pluginSecretStatus({ pluginId: required.pluginId, signal });
      if (signal?.aborted) return;
      if (!result?.ok) { setStatus(failure); return; }
      setStatus(result.value.configured ? 'Secret configured' : 'Secret not configured');
    } catch { if (!signal?.aborted) setStatus(failure); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => { const active = required.runtime.abort(); controller.current = active; lock.current = false; void perform({}); return () => active.abort(); }, [required.api, required.runtime, required.pluginId]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    const request = pluginSecretSetSchema.safeParse({ pluginId: required.pluginId, values: readCardForm({ event, card: required.card }).values });
    if (!request.success || !Object.keys(request.data.values ?? {}).length) { setStatus('Enter valid secret fields.'); return; }
    void perform({ request: request.data });
  };
  const clear = (event: MouseEvent<HTMLButtonElement>): void => { event.currentTarget.form?.reset(); void perform({ request: { pluginId: required.pluginId, values: null } }); };
  const refresh = (): void => { void perform({}); };
  return { status, busy, submit, clear, refresh, fields: cardFields({ card: required.card, busy }) };
}
/** Read declared names, omit blanks and reset synchronously before dispatch; O(f) time/space, f <=16. */
function readCardForm(required: { event: FormEvent<HTMLFormElement>; card: CredentialCard }) {
  required.event.preventDefault();
  const data = new FormData(required.event.currentTarget);
  required.event.currentTarget.reset();
  const fields = required.card.saveKind === 'plugin-secret' ? required.card.secretFields ?? [] : [...(required.card.fields ?? []), ...(required.card.secretFields ?? [])];
  const values = Object.fromEntries(fields.map(field => [field.name, data.get(field.name)]).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  return { values, connectionId: String(data.get('connectionId') ?? '') };
}
/** Only structured connection fields coerce integers; OAuth extras always remain strings. */
function connectionPlaintext(required: { card: CredentialCard; values: Record<string, string> }): string | null {
  if (required.card.saveKind === 'api-key') return required.values.token ?? '';
  const values: Record<string, string | number> = { ...required.values };
  for (const field of required.card.fields ?? []) {
    if (field.type !== 'integer' || !(field.name in values)) continue;
    const value = Number(values[field.name]);
    if (!Number.isSafeInteger(value)) return null;
    values[field.name] = value;
  }
  return Object.keys(values).length ? JSON.stringify(values) : null;
}
/** Prepare field attributes in the hook layer; secret fields always render as private passwords. */
function cardFields(required: { card: CredentialCard; busy: boolean }) {
  const fields = required.card.saveKind === 'plugin-secret' ? [] : required.card.fields ?? [];
  return [...fields.map(field => ({ ...field, inputType: field.type === 'integer' ? 'number' : 'text', maxLength: 2048 })),
    ...(required.card.secretFields ?? []).map(field => ({ ...field, inputType: 'password', maxLength: required.card.saveKind === 'api-key' ? 65536 : 8192 }))]
    .map(field => ({ ...field, id: required.card.pluginId + '-' + required.card.target + '-' + field.name, busy: required.busy }));
}


/** Textarea uses one key=value pair per line; identifiers remain strings and duplicate keys fail.
 * Native String operations only; split at the first '=' so values are never silently truncated.
 * @complexity O(text bytes), <=4096 bytes per field from the form; pure, no side effects.
 */
function conversionMap(required: { text: string }): Record<string, string> | null {
  const entries = required.text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return separator < 1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
  });
  if (entries.some(entry => entry === null)) return null;
  const pairs = entries.filter(entry => entry !== null);
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return null;
  return Object.fromEntries(pairs);
}

/** Interpret only declared form fields. Blank fields omit values; all blank explicitly clears.
 * @complexity O(fields + text bytes), <=8 fields/4096 bytes each; shared schema validates shape.
 */
function conversionFormValues(required: { declaration: ConversionSettingsDeclaration; data: FormData }): ConversionSettingsValues | null {
  const values: ConversionSettingsValues = {};
  for (const field of required.declaration.fields) {
    const text = String(required.data.get(field.name) ?? '').trim();
    if (!text) continue;
    const value = field.kind === 'string' ? text : conversionMap({ text });
    if (value === null) return null;
    values[field.name] = value;
  }
  return values;
}

/** Load/save one installed plugin's non-secret workspace settings. No write retries or verification claims.
 * @example useConversionSettings({ api, runtime, pluginId });
 * @complexity <=8 declared fields and <=4096 stored bytes; one bounded HTTP request per action.
 */
export function useConversionSettings(required: IntegrationsPageProps & { pluginId: string }) {
  const [settings, setSettings] = useState<ConversionSettingsStatus | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const failure = 'Conversion settings could not be confirmed. Refresh before resubmitting.';
  const perform = async (input: { request?: { pluginId: string; values: ConversionSettingsValues } }): Promise<void> => {
    if (lock.current) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true); setStatus('');
    try {
      const result = input.request ? await required.api.addons?.setConversionSettings({ request: input.request, signal })
        : await required.api.addons?.conversionSettings({ pluginId: required.pluginId, signal });
      if (signal?.aborted) return;
      if (!result?.ok) { setStatus(failure); return; }
      setSettings(result.value); setStatus(input.request ? 'Saved' : '');
    } catch { if (!signal?.aborted) setStatus(failure); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => {
    const active = required.runtime.abort(); controller.current = active; lock.current = false; setSettings(null);
    void perform({});
    return () => active.abort();
  }, [required.api, required.runtime, required.pluginId]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!settings?.declaration || lock.current) return;
    const values = conversionFormValues({ declaration: settings.declaration, data: new FormData(event.currentTarget) });
    const request = setConversionSettingsSchema.safeParse({ pluginId: required.pluginId, values });
    if (!request.success) { setStatus('Enter valid settings; mappings use one unique key=value pair per line.'); return; }
    void perform({ request: request.data });
  };
  const refresh = (): void => { void perform({}); };
  const fields = (settings?.declaration?.fields ?? []).map(field => {
    const value = settings?.values?.[field.name];
    const defaultValue = typeof value === 'string' ? value : Object.entries(value ?? {}).map(([key, value]) => key + '=' + value).join('\n');
    return { ...field, id: required.pluginId + '-conversion-' + field.name, defaultValue, busy,
      inputType: 'text', maxLength: field.kind === 'string' ? 128 : 4096, required: false, nonSecret: true };
  });
  return { declaration: settings?.declaration ?? null, fields, status, busy, submit, refresh };
}
