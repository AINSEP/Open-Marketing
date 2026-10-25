/** Secure owner form state. Tokens never enter snapshots, messages, or local storage. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { connectIntegrationTokenSchema } from '@open-marketing/contracts';
import type { z } from 'zod';
import { oauthClientSetSchema, oauthChallengeSchema } from '../../../shared/api/index.js';
import type { OAuthPlugin, OAuthStatus } from '../../../shared/api/index.js';
import type { ConfirmationCard, IntegrationSummary } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

export interface IntegrationsPageProps { api: StudioApiPort; runtime: StudioRuntime }
export const VENDORS = [
  { id: 'google-ads', label: 'Google Ads' }, { id: 'meta-ads', label: 'Meta · Facebook and Instagram' },
  { id: 'linkedin-ads', label: 'LinkedIn Ads' }, { id: 'tiktok-ads', label: 'TikTok Ads' },
  { id: 'higgsfield-media', label: 'Higgsfield' }, { id: 'anthropic', label: 'Anthropic AI provider' },
  { id: 'external-mcp', label: 'External MCP servers' },
] as const;
export interface ConnectionRowProps { connection: IntegrationSummary; busy: boolean; disconnect(required: { connectionId: string }): Promise<void> }

/** Private paste-token connection state. A submitted token is cleared before HTTP starts, including failed writes.
 * @example useIntegrations({ api, runtime });
 * @complexity <=100 summaries/page; one write and one refresh, no retries or vendor calls.
 */
export function useIntegrations(required: IntegrationsPageProps) {
  const [items, setItems] = useState<IntegrationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pluginId, setPluginId] = useState<string>('google-ads');
  const [connectionId, setConnectionId] = useState('');
  const [token, setToken] = useState('');
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
      if (!required.api.addons) { setError('Integrations are unavailable on this server.'); return; }
      const result = await required.api.addons.integrations({ query: { limit: 100, cursor: input.cursor }, signal: input.signal });
      if (!mounted.current || input.signal?.aborted || epoch !== readEpoch.current) return;
      if (!result.ok) { setError('Connections could not be loaded.'); return; }
      setItems(result.value.items); setCursor(result.value.cursor);
    } catch { if (mounted.current) setError('Connections could not be loaded.'); }
    finally { if (mounted.current && epoch === readEpoch.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = required.runtime.abort();
    void load({ signal: controller.signal });
    return () => { mounted.current = false; readEpoch.current++; controller.abort(); };
  }, [required.api, required.runtime]);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (lock.current) return;
    const request = connectIntegrationTokenSchema.safeParse({ pluginId, connectionId: connectionId || required.runtime.ids.next({}), plaintext: token });
    setToken(''); setError(''); setNotice('');
    if (!request.success) { setError('Choose a vendor and enter an access token (up to 64 KiB).'); return; }
    if (!required.api.addons) { setError('Integrations are unavailable on this server.'); return; }
    lock.current = true; setBusy(true);
    try {
      const result = await required.api.addons.connect({ request: request.data });
      if (!mounted.current) return;
      if (!result.ok) { setError('Connection could not be saved. Refresh before another submission.'); return; }
      setConnectionId(''); setNotice('Saved on the server.'); await load();
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
  const changeVendor = (event: ChangeEvent<HTMLSelectElement>): void => { setPluginId(event.currentTarget.value); setToken(''); };
  const changeId = (event: ChangeEvent<HTMLInputElement>): void => setConnectionId(event.currentTarget.value);
  const changeToken = (event: ChangeEvent<HTMLInputElement>): void => setToken(event.currentTarget.value);
  const refresh = (): void => { setError(''); void load(); };
  const next = (): void => { if (cursor) void load({ cursor }); };
  return { tokenRows: VENDORS.filter(vendor => !OAUTH_VENDORS.some(oauth => oauth.pluginId === vendor.id)).map(vendor => ({ ...vendor, status: vendorStatus({ connections: items, pluginId: vendor.id }) })), oauthRows: OAUTH_VENDORS.map(vendor => ({ ...required, ...vendor, connections: items })), items, pluginId, connectionId, token, busy: busy || loading, error, notice, submit, disconnect, changeVendor, changeId, changeToken, refresh, next, cursor, rows: items.map(connection => ({ connection, busy: busy || loading, disconnect })), vendors: VENDORS };
}
/** Connection row binding and labels are presentation-only; saved does not claim verification. */
export function useConnectionRow(required: ConnectionRowProps) {
  const vendor = VENDORS.find(row => row.id === required.connection.pluginId);
  const labels = { saved: 'Saved', reconnect_required: 'Reconnect required', disconnected: 'Disconnected' };
  return { label: vendor?.label ?? required.connection.pluginId, status: labels[required.connection.status],
    disconnect: () => { void required.disconnect({ connectionId: required.connection.connectionId }); } };
}

export interface OAuthVendorProps extends IntegrationsPageProps { pluginId: OAuthPlugin; label: string; connections: readonly IntegrationSummary[] }
export const OAUTH_VENDORS: readonly { pluginId: OAuthPlugin; label: string }[] = [
  { pluginId: 'google-ads', label: 'Google' }, { pluginId: 'linkedin-ads', label: 'LinkedIn' }, { pluginId: 'meta-ads', label: 'Meta' },
];

/** Private client configuration and policy-owned sign-in, using one cancellable owner request at a time.
 * Manual status checks are bounded to one operation and one transaction read; no write retries.
 * @example useOAuthVendor({ api, runtime, pluginId: 'google-ads', label: 'Google', connections });
 * @complexity O(n) connection display (n <=100), O(1) request state; HTTP deadlines are 15s.
 */
export function useOAuthVendor(required: OAuthVendorProps) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [configId, setConfigId] = useState('');
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
  const clearFields = (): void => { setClientId(''); setClientSecret(''); setConfigId(''); };
  const acceptChallenge = (input: { output: unknown }): void => {
    const parsed = oauthChallengeSchema.safeParse(input.output);
    if (!parsed.success || parsed.data.expiresAt <= required.runtime.clock.now({})) { operationId.current = null; setCard(null); setError('Sign-in link unavailable or expired. Start a new sign-in.'); return; }
    setCard(null); setChallenge(parsed.data); setNotice('Sign-in pending. Open the secure sign-in link.');
    required.runtime.timers.cancel({ handle: expiry.current });
    expiry.current = required.runtime.timers.schedule({ delayMs: parsed.data.expiresAt - required.runtime.clock.now({}), callback: () => {
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
    applyOAuthStatus({ status: result.value, setConfigured, setGuidance, setNotice });
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
    required.runtime.timers.cancel({ handle: expiry.current });
    expiry.current = required.runtime.timers.schedule({ delayMs: Math.max(0, pending.value.expiresAt - required.runtime.clock.now({})), callback: () => {
      setCard(null); setNotice('Sign-in approval expired. Check status before starting again.');
    } });
  };
  /** Only explicit cancellation/interruption permits restarting; unknown outcomes retain the operation.
   * @complexity O(1), one operation read and at most one identity-checked approval read; no write retries.
   */
  const readOperation = async (input: { id: string }): Promise<void> => {
    const signal = controller.current?.signal;
    const result = await required.api.operation?.({ operationId: input.id, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Sign-in operation unavailable.'); return; }
    if (result.value.operationId !== input.id) { setError('Sign-in operation identity mismatch.'); return; }
    if (result.value.status === 'completed') { acceptChallenge({ output: result.value.output }); return; }
    if (result.value.status === 'pending') {
      const cardId = result.value.cardId ?? pendingCardId.current;
      if (cardId) { await readApproval({ id: input.id, cardId }); return; }
      setNotice('Awaiting sign-in outcome.'); return;
    }
    setCard(null); required.runtime.timers.cancel({ handle: expiry.current });
    if (result.value.status === 'unknown') { setNotice('Sign-in outcome unresolved. Check status again before starting another sign-in.'); return; }
    operationId.current = null; pendingCardId.current = null; setNotice('Sign-in did not complete. Start again.');
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
  const saveClient = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const client = { clientId, ...(clientSecret ? { clientSecret } : {}), ...(required.pluginId === 'meta-ads' ? { configId } : {}) };
    clearFields();
    void perform({ work: async () => {
    const signal = controller.current?.signal;
      const request = oauthClientSetSchema.safeParse({ pluginId: required.pluginId, client });
      if (!request.success) { setError('Enter a client ID and valid client configuration.'); return; }
      const result = await required.api.addons?.setOAuthClient({ request: request.data, signal });
      if (signal?.aborted) return;
      if (!result?.ok) { setError('Client configuration could not be confirmed. Refresh before resubmitting.'); return; }
      setConfigured(result.value.configured); setNotice('Client configured on the server. Sign-in is a separate step.');
    } });
  };
  const clearClient = (): void => { clearFields(); void perform({ work: async () => {
    const signal = controller.current?.signal;
    const result = await required.api.addons?.setOAuthClient({ request: { pluginId: required.pluginId, client: null }, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Client clear could not be confirmed. Refresh before resubmitting.'); return; }
    setConfigured(false); setNotice('Client configuration cleared.');
  } }); };
  const signIn = (): void => {
    if (operationId.current) return;
    void perform({ work: async () => {
    const signal = controller.current?.signal;
    setChallenge(null); setCard(null); required.runtime.timers.cancel({ handle: expiry.current });
    const id = required.runtime.ids.next({}); operationId.current = id; pendingCardId.current = null;
    const result = await required.api.tool?.({ call: { name: 'integrations_oauth_start', operationId: id, input: { pluginId: required.pluginId } }, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setError('Sign-in could not be confirmed. Check status before starting again.'); return; }
    if (result.value.status === 'completed') { acceptChallenge({ output: result.value.output }); return; }
    if (result.value.operationId !== id) { setError('Sign-in operation identity mismatch.'); return; }
    operationId.current = result.value.operationId;
    if (!result.value.cardId) { setNotice('Awaiting sign-in outcome.'); return; }
    await readApproval({ id, cardId: result.value.cardId });
  } }); };
  const changeClientId = (event: ChangeEvent<HTMLInputElement>): void => setClientId(event.currentTarget.value);
  const changeClientSecret = (event: ChangeEvent<HTMLInputElement>): void => setClientSecret(event.currentTarget.value);
  const changeConfigId = (event: ChangeEvent<HTMLInputElement>): void => setConfigId(event.currentTarget.value);
  return { clientId, clientSecret, configId, configured, guidance, notice, error, busy, card, challenge,
    awaitingOperation: operationId.current !== null, saveClient, clearClient, signIn, refresh, changeClientId, changeClientSecret, changeConfigId,
    connectionStatus: vendorStatus({ connections: required.connections, pluginId: required.pluginId }),
  };
}
/** Configuration and saved account status remain separate; neither claims a working vendor connection. */
function applyOAuthStatus(required: { status: OAuthStatus; setConfigured: (value: boolean) => void; setGuidance: (value: string) => void; setNotice: (value: string) => void }): void {
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

/** Google-only private secret control: state stores no token after dispatch and replies are booleans.
 * @example useDeveloperToken({ api, runtime });
 * @complexity O(1); one request at a time with the HTTP adapter's deadline; no retries.
 */
export function useDeveloperToken(required: IntegrationsPageProps) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('Status unavailable');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const read = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    const signal = controller.current?.signal;
    try {
      const result = await required.api.addons?.developerTokenStatus({ pluginId: 'google-ads', signal });
      if (!signal?.aborted) setStatus(result?.ok ? (result.value.configured ? 'Developer token configured' : 'Developer token not configured') : 'Status unavailable');
    } catch { if (!signal?.aborted) setStatus('Status unavailable'); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  useEffect(() => { const active = required.runtime.abort(); controller.current = active; lock.current = false; void read(); return () => active.abort(); }, [required.api, required.runtime]);
  const save = async (input: { token: string | null }): Promise<void> => {
    setToken('');
    if (lock.current) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true);
    try {
      const result = await required.api.addons?.setDeveloperToken({ request: { pluginId: 'google-ads', token: input.token }, signal });
      if (!signal?.aborted) setStatus(result?.ok ? (result.value.configured ? 'Developer token configured' : 'Developer token cleared') : 'Save unconfirmed. Refresh before resubmitting.');
    } catch { if (!signal?.aborted) setStatus('Save unconfirmed. Refresh before resubmitting.'); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void save({ token }); };
  const clear = (): void => { void save({ token: null }); };
  const refresh = (): void => { void read(); };
  const changeToken = (event: ChangeEvent<HTMLInputElement>): void => setToken(event.currentTarget.value);
  return { token, status, busy, submit, clear, refresh, changeToken };
}
