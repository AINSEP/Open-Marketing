/** Owner-only paste-token UI; credentials go directly to the authenticated server API. */
import { useIntegrations, useConnectionRow } from '../model/integrations.hooks.js';
import type { ConnectionRowProps, IntegrationsPageProps } from '../model/integrations.hooks.js';

export function IntegrationsPage(props: IntegrationsPageProps) {
  const page = useIntegrations(props);
  return <section className="settings-card" data-page="addons-integrations" aria-label="Integrations">
    <form onSubmit={page.submit} data-action="integrations_connect">
      <div className="appearance-control"><label htmlFor="integration-vendor">Vendor</label><select id="integration-vendor" value={page.pluginId} onChange={page.changeVendor} disabled={page.busy} data-field="pluginId">{page.vendors.map(renderVendor)}</select></div>
      <p><label htmlFor="integration-id">Connection name (optional)</label><input id="integration-id" value={page.connectionId} onChange={page.changeId} maxLength={256} disabled={page.busy} data-field="connectionId" /></p>
      <p><label htmlFor="integration-token">Access token</label><input id="integration-token" type="password" autoComplete="off" value={page.token} onChange={page.changeToken} maxLength={65536} required disabled={page.busy} data-field="plaintext" data-private="true" /></p>
      <button type="submit" disabled={page.busy} data-action="integrations_connect">Save token</button>
      <p className="muted">Tokens are saved encrypted on the server. Use a new connection name to save another account.</p>
    </form>
    <button type="button" onClick={page.refresh} disabled={page.busy} data-action="integrations_list">Refresh connections</button>
    {page.busy && <p role="status">Updating connection…</p>}
    {page.error && <p role="alert" className="error-notice">{page.error}</p>}
    {page.notice && <p role="status">{page.notice}</p>}
    {!page.items.length && !page.error && <p>No connections saved yet.</p>}
    <ul>{page.rows.map(renderConnection)}</ul>
    {page.cursor && <button type="button" onClick={page.next} disabled={page.busy} data-action="integrations_list">Next page</button>}
  </section>;
}
/** Narrow list-render ABI; no credential fields exist in the list contract. */
function renderConnection(row: ConnectionRowProps) { return <ConnectionRow key={row.connection.connectionId} {...row} />; }
function renderVendor(vendor: { id: string; label: string }) { return <option key={vendor.id} value={vendor.id}>{vendor.label}</option>; }
function ConnectionRow(props: ConnectionRowProps) {
  const row = useConnectionRow(props);
  return <li><h2>{row.label}</h2><p>{props.connection.connectionId} · {row.status}</p><button type="button" onClick={row.disconnect} disabled={props.busy || props.connection.status === 'disconnected'} data-action="integrations_disconnect" data-connection-id={props.connection.connectionId}>Disconnect</button></li>;
}
