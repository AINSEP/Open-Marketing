/** Owner-only paste-token UI; credentials go directly to the authenticated server API. */
import { useIntegrations, useConnectionRow, useOAuthVendor, useDeveloperToken } from '../model/integrations.hooks.js';
import type { ConnectionRowProps, IntegrationsPageProps, OAuthVendorProps } from '../model/integrations.hooks.js';

import { ApprovalCard } from '../../../features/approve/index.js';

export function IntegrationsPage(props: IntegrationsPageProps) {
  const page = useIntegrations(props);
  return <section data-page="addons-integrations" aria-label="Integrations">
    <div className="integration-grid">{page.oauthRows.map(renderOAuthVendor)}{page.tokenRows.map(renderTokenVendor)}</div>
    <section className="settings-card" aria-label="Paste-token connections"><h2>Connect with an access token</h2>
    <p className="muted">TikTok and other services use paste-token connections.</p>
    <form id="paste-token-form" onSubmit={page.submit} data-action="integrations_connect">
      <div className="appearance-control"><label htmlFor="integration-vendor">Vendor</label><select id="integration-vendor" value={page.pluginId} onChange={page.changeVendor} disabled={page.busy} data-field="pluginId">{page.vendors.map(renderVendor)}</select></div>
      <p><label htmlFor="integration-id">Connection name (optional)</label><input id="integration-id" value={page.connectionId} onChange={page.changeId} maxLength={256} disabled={page.busy} data-field="connectionId" /></p>
      <p><label htmlFor="integration-token">Access token</label><input id="integration-token" type="password" autoComplete="off" value={page.token} onChange={page.changeToken} maxLength={65536} required disabled={page.busy} data-field="plaintext" data-private="true" data-agent-private="true" /></p>
      <button type="submit" className="primary-button" disabled={page.busy} data-action="integrations_connect">Save token</button>
      <p className="muted">Tokens are saved encrypted on the server. Use a new connection name to save another account.</p>
    </form>
    <button type="button" onClick={page.refresh} disabled={page.busy} data-action="integrations_list">Refresh connections</button>
    {page.busy && <p role="status">Updating connection…</p>}
    {page.error && <p role="alert" className="error-notice">{page.error}</p>}
    {page.notice && <p role="status">{page.notice}</p>}
    {!page.items.length && !page.error && <p>No connections saved yet.</p>}
    <ul>{page.rows.map(renderConnection)}</ul>
    {page.cursor && <button type="button" onClick={page.next} disabled={page.busy} data-action="integrations_list">Next page</button>}
  </section><DeveloperTokenForm {...props} /></section>;
}
/** Narrow list-render ABI; no credential fields exist in the list contract. */
function renderConnection(row: ConnectionRowProps) { return <ConnectionRow key={row.connection.connectionId} {...row} />; }
function renderVendor(vendor: { id: string; label: string }) { return <option key={vendor.id} value={vendor.id}>{vendor.label}</option>; }
function ConnectionRow(props: ConnectionRowProps) {
  const row = useConnectionRow(props);
  return <li><h2>{row.label}</h2><p>{props.connection.connectionId} · {row.status}</p><button type="button" onClick={row.disconnect} disabled={props.busy || props.connection.status === 'disconnected'} data-action="integrations_disconnect" data-connection-id={props.connection.connectionId}>Disconnect</button></li>;
}

function renderOAuthVendor(props: OAuthVendorProps) { return <OAuthVendor key={props.pluginId} {...props} />; }
/** One vendor row keeps private configuration separate from account sign-in and reconnect evidence. */
function OAuthVendor(props: OAuthVendorProps) {
  const vendor = useOAuthVendor(props);
  return <section className="settings-card" aria-label={props.label + ' integration'}>
    <div className="integration-row"><div className="vendor-heading"><span className="vendor-icon" aria-hidden="true">↗</span><h2>{props.label}</h2></div><span className="integration-status">{vendor.connectionStatus}</span></div>
    <p>{vendor.configured === null ? 'Client status unavailable' : vendor.configured ? 'Client configured' : 'Client configuration required'}</p>
    {vendor.guidance && <p>{vendor.guidance}</p>}
    <div className="integration-actions"><button type="button" className="primary-button" onClick={vendor.signIn} disabled={vendor.busy || !vendor.configured || vendor.awaitingOperation}>Sign in with {props.label}</button><button type="button" onClick={vendor.refresh} disabled={vendor.busy}>Check {props.label} sign-in status</button>
      {vendor.challenge && <a href={vendor.challenge.authorizationUrl} target="_blank" rel="noopener noreferrer">Continue to {props.label}</a>}</div>
    {vendor.card && <ApprovalCard key={vendor.card.cardId} card={vendor.card} api={props.api} runtime={props.runtime} sample={false} />}
    {vendor.notice && <p role="status">{vendor.notice}</p>}{vendor.error && <p role="alert" className="error-notice">{vendor.error}</p>}
    <details><summary>OAuth client configuration</summary><p>Saved sealed on the server. Client secrets stay in this private form.</p>
      <form onSubmit={vendor.saveClient} data-private="true" data-agent-private="true">
        <label htmlFor={props.pluginId + '-client-id'}>Client ID<input id={props.pluginId + '-client-id'} value={vendor.clientId} onChange={vendor.changeClientId} maxLength={2048} autoComplete="off" required disabled={vendor.busy} data-private="true" data-agent-private="true" /></label>
        <label htmlFor={props.pluginId + '-client-secret'}>Client secret<input id={props.pluginId + '-client-secret'} type="password" value={vendor.clientSecret} onChange={vendor.changeClientSecret} maxLength={8192} autoComplete="off" disabled={vendor.busy} data-private="true" data-agent-private="true" /></label>
        {props.pluginId === 'meta-ads' && <label htmlFor="meta-config-id">Meta configuration ID<input id="meta-config-id" value={vendor.configId} onChange={vendor.changeConfigId} maxLength={128} required disabled={vendor.busy} data-private="true" data-agent-private="true" /></label>}
        <div className="integration-actions"><button type="submit" disabled={vendor.busy}>Save client configuration</button><button type="button" onClick={vendor.clearClient} disabled={vendor.busy}>Clear client configuration</button></div>
      </form>
    </details>
  </section>;
}
function DeveloperTokenForm(props: IntegrationsPageProps) {
  const field = useDeveloperToken(props);
  return <section className="settings-card" aria-label="Google developer token"><h2>Google developer token</h2><p role="status">{field.status}</p>
    <form onSubmit={field.submit} data-private="true" data-agent-private="true"><label htmlFor="google-developer-token">Developer token<input id="google-developer-token" type="password" autoComplete="off" value={field.token} onChange={field.changeToken} minLength={22} maxLength={22} pattern="[A-Za-z0-9]{22}" required disabled={field.busy} data-private="true" data-agent-private="true" /></label>
      <div className="integration-actions"><button type="submit" className="primary-button" disabled={field.busy}>Save developer token</button><button type="button" onClick={field.clear} disabled={field.busy}>Clear developer token</button><button type="button" onClick={field.refresh} disabled={field.busy}>Refresh developer token status</button></div>
    </form>
  </section>;
}

/** Paste-token vendors keep the same status row even before an account has been saved. */
function renderTokenVendor(vendor: { id: string; label: string; status: string }) { return <section key={vendor.id} className="settings-card" aria-label={vendor.label + ' integration'}><div className="integration-row"><h2>{vendor.label}</h2><span className="integration-status">{vendor.status}</span></div><p className="muted">Paste an access token in the connection form below.</p></section>; }
