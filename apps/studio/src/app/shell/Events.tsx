import { eventFields, useEvents } from './Events.hooks.js';
import type { CaptureEvent } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../shared/api/index.js';

/** Disposable local demo using the shell's existing Settings tokens and accessible controls. */
export function Events(props: { api: StudioApiPort; runtime: StudioRuntime }) {
  const events = useEvents(props);
  return <section className="settings-card" aria-label="Events · local demo">
    <h2>Events · local demo</h2><p>Local only · latest 100 events · cleared when this demo restarts.</p>
    <button type="button" onClick={events.refresh}>Refresh</button><p role="status">{events.status}</p>
    <ol aria-label="Recent events">{events.items.map(renderEvent)}</ol>
  </section>;
}
/** Fixed Array.map callback ABI supplies the disposable snapshot row key. */
function renderEvent(event: CaptureEvent, index: number) {
  return <li key={index}><strong>{event.kind} · {event.name}</strong> · <time>{event.at}</time><p>{eventFields({ event })}</p></li>;
}
