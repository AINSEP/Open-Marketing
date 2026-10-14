/** Secure owner form state. Tokens never enter snapshots, messages, or local storage. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { connectIntegrationTokenSchema } from '@open-marketing/contracts';
import type { IntegrationSummary } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

export interface IntegrationsPageProps { api: StudioApiPort; runtime: StudioRuntime }
export const VENDORS = [
  { id: 'google-ads', label: 'Google Ads' }, { id: 'meta-ads', label: 'Meta · Facebook and Instagram' },
  { id: 'linkedin-ads', label: 'LinkedIn Ads' }, { id: 'tiktok-ads', label: 'TikTok Ads' },
  { id: 'higgsfield-media', label: 'Higgsfield' }, { id: 'anthropic', label: 'Anthropic AI provider' },
  { id: 'external-mcp', label: 'External MCP servers' },
] as const;
export interface ConnectionRowProps { connection: IntegrationSummary; busy: boolean; disconnect(required: { connectionId: string }): Promise<void> }

/** Paste-token only. A submitted token is cleared before HTTP starts, including failed writes.
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
  return { items, pluginId, connectionId, token, busy: busy || loading, error, notice, submit, disconnect, changeVendor, changeId, changeToken, refresh, next, cursor, rows: items.map(connection => ({ connection, busy: busy || loading, disconnect })), vendors: VENDORS };
}
/** Connection row binding and labels are presentation-only; saved does not claim verification. */
export function useConnectionRow(required: ConnectionRowProps) {
  const vendor = VENDORS.find(row => row.id === required.connection.pluginId);
  const labels = { saved: 'Saved', reconnect_required: 'Reconnect required', disconnected: 'Disconnected' };
  return { label: vendor?.label ?? required.connection.pluginId, status: labels[required.connection.status],
    disconnect: () => { void required.disconnect({ connectionId: required.connection.connectionId }); } };
}
