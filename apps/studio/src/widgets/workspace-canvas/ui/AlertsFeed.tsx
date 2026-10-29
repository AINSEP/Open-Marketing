import type { ReactElement } from 'react';
import { useAlertsFeed } from './AlertsFeed.hooks.js';
import type { AlertRowProps, AlertsFeedProps } from './AlertsFeed.hooks.js';

/** Activity's durable server alert feed; callbacks and projection stay in its hook.
 * @example <AlertsFeed api={api} runtime={runtime} />
 */
export function AlertsFeed(props: AlertsFeedProps): ReactElement {
  const feed = useAlertsFeed(props);
  return <section className="canvas-card" aria-label="Alerts">
    <div className="canvas-card-body">
      <div className="section-heading"><h2>Alerts</h2><button type="button" onClick={feed.refresh} disabled={feed.busy}>Refresh alerts</button></div>
      {feed.rows.map(renderAlert)}
      {feed.loaded && feed.rows.length === 0 && <p>No alerts</p>}
      {feed.busy && <p role="status">Loading alerts…</p>}
      {feed.status && <p role="status">{feed.status}</p>}
      {feed.hasMore && <button type="button" onClick={feed.loadMore} disabled={feed.busy}>Load more alerts</button>}
    </div>
  </section>;
}

function renderAlert(row: AlertRowProps): ReactElement {
  return <article key={row.noticeId} aria-label={row.title}>
    <h3>{row.title}</h3><p>{row.createdAt}</p>
    {row.weekly && <WeeklyReport report={row.weekly} />}
    <p>{row.onAcknowledge ? <button type="button" onClick={row.onAcknowledge} disabled={row.busy}>Acknowledge</button>
      : row.acknowledged ? 'Acknowledged' : 'Awaiting acknowledgement'}</p>
  </article>;
}

/** Existing feed notice detail; all formatting and callbacks stay in the hook module. */
function WeeklyReport(props: { report: NonNullable<AlertRowProps['weekly']> }): ReactElement {
  return <div>
    <p>{props.report.period} · {props.report.currency} · {props.report.timezone}</p>
    <p>{props.report.coverage} · Missing days: {props.report.missingDays}</p>
    {props.report.observations.map(renderObservation)}
    <table aria-label="Weekly campaign results"><thead><tr>
      <th scope="col">Campaign</th><th scope="col">Spend</th><th scope="col">Clicks</th><th scope="col">Impressions</th>
      <th scope="col">Conversions (reported by platform)</th><th scope="col">Leads (OM-verified)</th>
    </tr></thead><tbody>{props.report.campaigns.map(renderCampaign)}</tbody></table>
    {props.report.omittedCampaigns > 0 && <p>{props.report.omittedCampaigns} additional campaigns omitted</p>}
    <p>Unattributed enquiries (workspace-wide): {props.report.unattributed}</p>
  </div>;
}
function renderObservation(text: string): ReactElement { return <p key={text}>{text}</p>; }
function renderCampaign(row: NonNullable<AlertRowProps['weekly']>['campaigns'][number]): ReactElement {
  return <tr key={row.id}><th scope="row">{row.id}</th><td>{row.spend}</td><td>{row.clicks}</td><td>{row.impressions}</td>
    <td>{row.conversions}</td><td>{row.leads}</td></tr>;
}
