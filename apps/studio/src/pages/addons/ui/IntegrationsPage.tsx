/** Owner-only manifest forms; private credentials go directly to the authenticated server API. */
import { useIntegrations, useConnectionRow, useOAuthVendor, usePluginSecret, useMailProvider, useConversionSettings } from '../model/integrations.hooks.js';
import type { ConnectionRowProps, IntegrationsPageProps, OAuthVendorProps, PluginCardRow } from '../model/integrations.hooks.js';
import { ApprovalCard } from '../../../features/approve/index.js';
import { ConversionGrants } from './ConversionGrants.js';

export function IntegrationsPage(props: IntegrationsPageProps) {
  const page = useIntegrations(props);
  return <section data-page="addons-integrations" aria-label="Integrations">
    <MailProviderCard {...props} />
    <div className="integration-grid">{page.pluginRows.map(renderPlugin)}</div>
    <section className="settings-card" aria-label="Connections"><h2>Connections</h2>
      <button type="button" onClick={page.refresh} disabled={page.busy} data-action="integrations_list">Refresh connections</button>
      {page.busy && <p role="status">Updating connection…</p>}
      {page.error && <p role="alert" className="error-notice">{page.error}</p>}
      {page.notice && <p role="status">{page.notice}</p>}
      {!page.items.length && !page.error && <p>No connections saved yet.</p>}
      <ul>{page.rows.map(renderConnection)}</ul>
      {page.cursor && <button type="button" onClick={page.next} disabled={page.busy} data-action="integrations_list">Next page</button>}
    </section>
    <ConversionGrants {...props} />
  </section>;
}
/** Labels and connection readiness come from the server's plugin declarations. */
function MailProviderCard(props: IntegrationsPageProps) {
  const mail = useMailProvider(props);
  return <section className="settings-card" aria-label="Mail provider"><h2>Mail provider</h2>
    <label>Mail provider<select value={mail.selected} onChange={mail.change} disabled={mail.busy || !mail.settings}>
      <option value="">None</option>
      {mail.stale && <option value={mail.settings?.selected ?? ''}>{mail.settings?.selected} (Unavailable)</option>}
      {mail.settings?.candidates.map(renderMailCandidate)}
    </select></label>
    <label>From address<input type="email" maxLength={254} value={mail.alertFrom} onChange={mail.changeFrom} placeholder="Default from plugin" aria-describedby="mail-from-hint" disabled={mail.busy || !mail.settings} /></label>
    <p id="mail-from-hint" className="muted">Default from plugin when empty.</p>
    <button type="button" onClick={mail.resetFrom} disabled={mail.busy || !mail.settings}>Use plugin default</button>
    <div className="integration-actions"><button type="button" onClick={mail.save} disabled={mail.busy || !mail.settings}>Save mail provider</button><button type="button" onClick={mail.refresh} disabled={mail.busy}>Refresh mail providers</button></div>
    {mail.status && <p role="status">{mail.status}</p>}
  </section>;
}
/** Native option rendering ABI; no provider-specific labels or connection policy. */
function renderMailCandidate(row: NonNullable<ReturnType<typeof useMailProvider>['settings']>['candidates'][number]) {
  return <option key={row.pluginId} value={row.pluginId}>{row.label} ({row.status === 'connected' ? 'Connected' : 'Not connected'})</option>;
}
/** Narrow list-render ABI; no credential fields exist in the list contract. */
function renderConnection(row: ConnectionRowProps) { return <ConnectionRow key={row.connection.connectionId} {...row} />; }
function ConnectionRow(props: ConnectionRowProps) {
  const row = useConnectionRow(props);
  return <li><h2>{row.label}</h2><p>{props.connection.connectionId} · {row.status}</p><button type="button" onClick={row.disconnect} disabled={props.busy || props.connection.status === 'disconnected'} data-action="integrations_disconnect" data-connection-id={props.connection.connectionId}>Disconnect</button></li>;
}
function renderPlugin(props: OAuthVendorProps) { return <PluginCards key={props.pluginId} {...props} />; }
/** One plugin owns its status read and existing policy-controlled OAuth lifecycle. */
function PluginCards(props: OAuthVendorProps) {
  const plugin = useOAuthVendor(props);
  const conversions = useConversionSettings(props);
  if (!plugin.cardRows.length && !plugin.error && !conversions.declaration) return null;
  return <section className="settings-card" aria-label={props.label + ' integration'}>
    <div className="integration-row"><div className="vendor-heading"><h2>{props.label}</h2></div><span className="integration-status">{plugin.connectionStatus}</span></div>
    {plugin.cardRows.map(renderCard)}
    <ConversionSettingsForm settings={conversions} />
    {plugin.notice && <p role="status">{plugin.notice}</p>}{plugin.error && <p role="alert" className="error-notice">{plugin.error}</p>}
  </section>;
}
/** Render only approved public guidance; unsupported declarations have no form or action. */
function renderCard(row: PluginCardRow) {
  return <article key={row.credential.target} aria-label={row.credential.label}>
    <h3>{row.credential.title}</h3><p>{row.credential.label}</p><p>{row.credential.intro}</p>
    {row.credential.keyHint && <p className="muted">{row.credential.keyHint}</p>}
    <a href={row.credential.helpUrl} target="_blank" rel="noopener noreferrer">{row.credential.helpLabel}</a>
    {row.credential.actionSupported ? renderCardAction(row) : <p>Setup unavailable on this server.</p>}
  </article>;
}
/** One dispatch point selects the existing action by manifest save kind. */
function renderCardAction(row: PluginCardRow) {
  switch (row.credential.saveKind) {
    case 'oauth': return <div>
      <p>{row.configured === null ? 'Client status unavailable' : row.configured ? 'Client configured' : 'Client configuration required'}</p>
      {row.guidance && <p>{row.guidance}</p>}
      <div className="integration-actions"><button type="button" className="primary-button" onClick={row.signIn} disabled={row.busy || !row.configured || row.awaitingOperation}>Sign in with {row.label}</button><button type="button" onClick={row.refresh} disabled={row.busy}>Check {row.label} sign-in status</button>
        {row.challenge && <a href={row.challenge.authorizationUrl} target="_blank" rel="noopener noreferrer">Continue to {row.label}</a>}</div>
      {row.card && <ApprovalCard key={row.card.cardId} card={row.card} api={row.api} runtime={row.runtime} sample={false} />}
    </div>;
    case 'oauth-client': return <form onSubmit={row.saveClient} data-private="true" data-agent-private="true">
      {row.fields.map(renderField)}<div className="integration-actions"><button type="submit" disabled={row.busy}>Save client configuration</button><button type="button" onClick={row.clearClient} disabled={row.busy}>Clear client configuration</button></div>
    </form>;
    case 'api-key': case 'app-credentials': return <form onSubmit={row.submitConnection} data-action="integrations_connect" data-private="true" data-agent-private="true">
      <label>Connection name (optional)<input name="connectionId" maxLength={256} disabled={row.busy} data-private="true" data-agent-private="true" /></label>
      {row.fields.map(renderField)}<button type="submit" className="primary-button" disabled={row.busy} data-action="integrations_connect">Save token</button>
    </form>;
    case 'plugin-secret': return <PluginSecretForm {...row} />;
    default: return <p>Setup unavailable on this server.</p>;
  }
}
/** Hooks prepare uncontrolled inputs; credential fields stay private, declared settings are public. */
function renderField(field: PluginCardRow['fields'][number] & { defaultValue?: string; nonSecret?: boolean }) {
  return <label key={field.id + (field.defaultValue ?? '')} htmlFor={field.id}>{field.label}<input id={field.id} name={field.name} type={field.inputType} maxLength={field.maxLength} autoComplete="off" defaultValue={field.defaultValue} required={field.required} disabled={field.busy} aria-describedby={field.hint ? field.id + '-hint' : undefined} data-private={field.nonSecret ? undefined : true} data-agent-private={field.nonSecret ? undefined : true} />{field.hint && <span id={field.id + '-hint'} className="muted">{field.hint}</span>}</label>;
}
/** Only declared plugin-secret cards mount a secret status reader. */
function PluginSecretForm(props: PluginCardRow) {
  const field = usePluginSecret({ ...props, card: props.credential });
  return <div><p role="status">{field.status}</p>
    <form onSubmit={field.submit} data-private="true" data-agent-private="true">{field.fields.map(renderField)}
      <div className="integration-actions"><button type="submit" className="primary-button" disabled={field.busy}>Save secret</button><button type="button" onClick={field.clear} disabled={field.busy}>Clear secret</button><button type="button" onClick={field.refresh} disabled={field.busy}>Refresh secret status</button></div>
    </form>
  </div>;
}

/** Non-secret declared fields share the existing renderer; maps use a native multiline input. */
function ConversionSettingsForm(props: { settings: ReturnType<typeof useConversionSettings> }) {
  if (!props.settings.declaration) return null;
  return <form onSubmit={props.settings.submit} aria-label="Conversion settings"><h3>Conversion settings</h3>
    <p className="muted">Saved for this workspace. Leave all fields blank to clear.</p>
    {props.settings.fields.map(renderConversionField)}
    <div className="integration-actions"><button type="submit" disabled={props.settings.busy}>Save conversion settings</button><button type="button" onClick={props.settings.refresh} disabled={props.settings.busy}>Refresh conversion settings</button></div>
    {props.settings.status && <p role="status">{props.settings.status}</p>}
  </form>;
}
/** Narrow native list-render ABI; presentation only, with no component-body callbacks. */
function renderConversionField(field: ReturnType<typeof useConversionSettings>['fields'][number]) {
  if (field.kind === 'string') return renderField(field);
  return <label key={field.id + field.defaultValue} htmlFor={field.id}>{field.label}
    <textarea id={field.id} name={field.name} maxLength={4096} rows={4} defaultValue={field.defaultValue} disabled={field.busy} aria-describedby={field.hint ? field.id + '-hint' : undefined} />
    {field.hint && <span id={field.id + '-hint'} className="muted">{field.hint}</span>}
  </label>;
}
