import { useTracking } from '../model/tracking.hooks.js';
import type { TrackingProps, TrackingTemplate } from '../model/tracking.hooks.js';

/** Existing Measure setup panel: generate, copy, check evidence and explicitly select a fallback. */
export function TrackingPage(props: TrackingProps) {
  const tracking = useTracking(props);
  return <section className="settings-card" aria-label="Tracking setup">
    <h2>Tracking setup</h2>
    <p>Proxy /c, /web-events.js and /f/* to OM on your HTTPS site origin.</p>
    <form onSubmit={tracking.generate}>
      <fieldset disabled={tracking.busy}>
        <label>Destination URL<input type="url" required maxLength={2048} value={tracking.destinationUrl} onChange={tracking.changeDestination} /></label>
        <label>Campaign keys (optional JSON, up to 2)<textarea maxLength={2048} value={tracking.campaignKeys} onChange={tracking.changeKeys} placeholder={'[{"pluginId":"…","accountId":"…","vendorCampaignId":"…"}]'} /></label>
        <button type="submit">Generate setup</button>
        <label>Fallback form slug (optional)<input maxLength={100} value={tracking.fallbackSlug} onChange={tracking.changeFallback} /></label>
        <button type="button" onClick={tracking.checkReadiness}>Check readiness</button>
      </fieldset>
    </form>
    {tracking.busy && <p role="status">Checking tracking…</p>}
    {tracking.error && <p role="alert">{tracking.error}</p>}
    {tracking.setup && <div>
      <p>Install this JavaScript on your destination. Tracking and tags wait for visitor consent: set window.omConsent = true before loading, or call window.omGrantConsent() after consent.</p>
      <label>Installation source<textarea readOnly rows={8} ref={tracking.sourceRef} value={tracking.setup.source} /></label>
      <button type="button" onClick={tracking.selectSource}>Select source to copy</button>
      <p>Copy the selected source with your browser’s Copy command.</p>
      <ul aria-label="Campaign URL templates">{tracking.setup.campaignUrlTemplates.map(renderTemplate)}</ul>
    </div>}
    {tracking.readiness && <div>
      <p role="status">Collector: {tracking.readiness.status}</p>
      <p>Recent collector evidence does not prove vendor delivery or website reachability.</p>
      {tracking.readiness.fallbackUrl && <p>Published fallback: <a href={tracking.readiness.fallbackUrl}>{tracking.readiness.fallbackUrl}</a> <button type="button" onClick={tracking.selectFallback}>Use hosted form</button></p>}
    </div>}
  </section>;
}

/** React's map ABI; template text is escaped by React and never executed. */
const renderTemplate = ((item: TrackingTemplate, index: number) =>
  <li key={index}><strong>{item.campaignKey.pluginId} / {item.campaignKey.vendorCampaignId}</strong><pre>{item.template}</pre></li>
) satisfies Parameters<TrackingTemplate[]['map']>[0];
