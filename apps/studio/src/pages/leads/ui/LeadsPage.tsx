import { useLeads } from '../model/leads.hooks.js';
import type { LeadRowProps, LeadsProps } from '../model/leads.hooks.js';

/** First 50 leads; history remains available through the shared assistant/CLI tools. */
export function LeadsPage(props: LeadsProps) {
  const inbox = useLeads(props);
  return <section className="settings-card" aria-label="Lead inbox">
    <h2>Lead inbox</h2>
    <p>First 50 enquiries. Attribution uses the last observed paid touch within 30 days.</p>
    {inbox.busy && <p role="status">Loading leads…</p>}
    {inbox.error && <p role="alert">{inbox.error}</p>}
    {!inbox.busy && !inbox.error && inbox.rows.length === 0 && <p>No leads yet.</p>}
    <ul aria-label="Leads">{inbox.rows.map(renderLead)}</ul>
  </section>;
}

/** React map ABI; all event handlers are supplied by the model. */
const renderLead = ((row: LeadRowProps) => <LeadRow key={row.lead.leadId} {...row} />) satisfies Parameters<LeadRowProps[]['map']>[0];

/** Render scoped references only; no contact details or form answers enter the inbox. */
function LeadRow(props: LeadRowProps) {
  const campaign = props.lead.attribution.campaign;
  return <li>
    <p><strong>{props.lead.source.kind}: {props.lead.source.ref}</strong></p>
    <p>{campaign ? <>{campaign.pluginId} / {campaign.accountId} / {campaign.vendorCampaignId}</> : 'Unattributed'}</p>
    <label>Stage for {props.lead.source.ref}
      <select value={props.lead.stage} onChange={props.onChange} disabled={props.disabled}>
        <option value="new">New</option><option value="qualified">Qualified</option><option value="won">Won</option>
        <option value="disqualified">Disqualified</option><option value="spam">Spam</option>
      </select>
    </label>
  </li>;
}
