import { ApprovalCard } from '../../../features/approve/index.js';
import { useConversionGrants } from '../model/conversion-grants.hooks.js';
import type { ConversionGrantRow } from '../model/conversion-grants.hooks.js';
import type { IntegrationsPageProps } from '../model/integrations.hooks.js';

/** Owner-managed conversion sharing beside Connections; exact cards remain server-owned. */
export function ConversionGrants(props: IntegrationsPageProps) {
  const grants = useConversionGrants(props);
  return <section className="settings-card" aria-label="Conversion sharing grants"><h2>Conversion sharing</h2>
    <p>Authorize sharing conversion data for these definitions with the destination plugin. Visitor consent is also required for every dispatch.</p>
    <form onSubmit={grants.submit} aria-label="Grant conversion sharing">
      <fieldset disabled={grants.disabled}><legend>New conversion-sharing grant</legend>
        <label>Connection ID<input name="connectionId" maxLength={256} required /></label>
        <label>Destination plugin ID<input name="destination" maxLength={256} required /></label>
        <label>Account ID<input name="accountId" maxLength={256} required /></label>
        <label>Definition IDs (comma-separated)<input name="definitionIds" maxLength={4111} required /></label>
        <label>Purpose<input name="purpose" defaultValue="measurement" maxLength={256} required /></label>
        <label>Valid for days<input name="days" type="number" defaultValue={30} min={1} max={365} required /></label>
        <button type="submit">Grant conversion sharing</button>
      </fieldset>
    </form>
    <button type="button" onClick={grants.refresh} disabled={grants.busy}>Refresh grants</button>
    {grants.pending && <p role="status">Request pending. Refresh grants after answering the card.</p>}
    {grants.error && <p role="alert" className="error-notice">{grants.error}</p>}
    {grants.notice && <p role="status">{grants.notice}</p>}
    {grants.card && <ApprovalCard key={grants.card.cardId} card={grants.card} api={props.api} runtime={props.runtime} sample={false} />}
    <ul aria-label="Conversion grants">{grants.rows.map(renderGrant)}</ul>
    {grants.cursor && <button type="button" onClick={grants.next} disabled={grants.busy || grants.pending}>Next grants</button>}
  </section>;
}

/** Bounded parsed data renders as text, with no executable plugin content. */
function renderGrant(row: ConversionGrantRow) {
  return <li key={row.grant.grantId}><h3>{row.grant.grantId} · {row.status}</h3>
    <p>{row.grant.destination} · {row.grant.connectionId} · {row.grant.accountId}</p>
    <p>Definitions: {row.grant.definitionIds.join(', ')} · Purpose: {row.grant.purpose} · Expires: {row.expires}</p>
    <button type="button" onClick={row.revoke} disabled={row.disabled} aria-label={'Revoke ' + row.grant.grantId}>Revoke</button>
  </li>;
}
