import { useMeasure } from '../model/measure.hooks.js';
import type { IntegrationSummary } from '@open-marketing/contracts';
import type { MeasureDisplay, MeasureProps } from '../model/measure.hooks.js';

/** Persisted vendor observations beside frozen OM creation cohorts, without mixed totals. */
export function MeasurePage(props: MeasureProps) {
  const measure = useMeasure(props);
  return <section className="settings-card" aria-label="Campaign results">
    <h2>Campaign results</h2>
    <fieldset disabled={measure.busy}>
      <label>Connection<select value={measure.form.connectionId} onChange={measure.onConnection}>
        <option value="">Choose a connection</option>{measure.connections.map(renderConnection)}
      </select></label>
      <label>Account ID<input value={measure.form.accountId} onChange={measure.onAccount} maxLength={256} /></label>
      <label>Start date<input type="date" value={measure.form.start} onChange={measure.onStart} /></label>
      <label>End date (exclusive)<input type="date" value={measure.form.end} onChange={measure.onEnd} /></label>
      <p>Choose 1–31 days. Load reads saved observations; Refresh queues a new observation.</p>
      <button type="button" onClick={measure.load}>Load</button><button type="button" onClick={measure.refresh}>Refresh</button>
    </fieldset>
    {measure.reconnect && <p>Reconnect required. <a href="#/addons/integrations">Open Integrations</a></p>}
    {measure.disconnected && <p>Connection disconnected. <a href="#/addons/integrations">Open Integrations</a></p>}
    {measure.busy && <p role="status">Loading…</p>}
    {measure.status && <p role="status">{measure.status}</p>}
    {measure.error && <p role="alert">{measure.error}</p>}
    {measure.display && <Results display={measure.display} />}
  </section>;
}
/** React map ABI, connection identity is obtained only from the existing integrations API. */
function renderConnection(connection: IntegrationSummary) {
  return <option key={connection.connectionId} value={connection.connectionId}>{connection.pluginId} / {connection.connectionId}</option>;
}
function Results(props: { display: MeasureDisplay }) {
  return <div>
    <p>{props.display.period}; timezone: {props.display.timezone}</p>
    <table><caption>Persisted campaign results</caption><thead><tr>
      <th scope="col">Campaign</th><th scope="col">Spend</th><th scope="col">Impressions</th><th scope="col">Clicks</th>
      <th scope="col">Conversions (reported by platform)</th><th scope="col">Leads (OM-verified)</th>
    </tr></thead><tbody>{props.display.rows.map(renderRow)}</tbody></table>
    {props.display.rows.length === 0 && <p>No campaign observations or attributed leads for this period.</p>}
    <p>Workspace unattributed enquiries: {props.display.unattributed}. Counted in this account’s timezone; never sum across account views.</p>
    <p>Last paid touch within 30 days (last_paid_touch_30d.v1), frozen when the lead is captured. Visitors are tracked only after consent; enquiries without a consented paid touch appear as unattributed.</p>
    <p>Coverage: {props.display.coverage}. Missing days: {props.display.missingDays}.</p>
    <ul aria-label="Reporting observations">{props.display.observations.map(renderObservation)}</ul>
  </div>;
}
/** React map ABIs; metric formatting and evidence projection live in the model. */
function renderRow(row: MeasureDisplay['rows'][number]) {
  return <tr key={row.id}><th scope="row">{row.id}</th><td>{row.spend}</td><td>{row.impressions}</td><td>{row.clicks}</td><td>{row.conversions}</td><td>{row.leads}</td></tr>;
}
const renderObservation = ((observation: string) => <li key={observation}>{observation}</li>) satisfies Parameters<string[]['map']>[0];
