/** Disposable local diagnostics; never approval authority or durable audit evidence. */
import { captureEventSchema, parseBoundary, recentEventsSchema } from '@open-marketing/contracts';
import type { CaptureEvent, ClockPort, ObserverPort, Outcome, RecentEvents } from '@open-marketing/contracts';
import { localFailure } from './composition/local-auth.js';

/** One injected buffer per boot. Invalid/oversized events return typed failures; newest evicts oldest.
 * Diagnostics destinations fail independently. Disposal clears data and stops capture.
 * @example const events = createRecentEvents({ clock, observer }); events.recent({});
 * @complexity O(100) time/space at capacity; each event <=2 KiB, no I/O.
 */
export function createRecentEvents(required: { clock: ClockPort; observer: ObserverPort }) {
    const items: CaptureEvent[] = [];
    let disposed = false;
    function capture(input: { event: unknown }): Outcome<{ status: 'recorded' }> {
        if (disposed) return localFailure({ message: 'Local events disposed' });
        try {
            const parsed = parseBoundary({ schema: captureEventSchema, input: input.event });
            if (!parsed.ok) return parsed;
            items.push(parsed.value);
            if (items.length > 100) items.shift();
            return { ok: true, value: { status: 'recorded' } };
        } catch { return localFailure({ message: 'Local event capture unavailable' }); }
    }
    const observer: ObserverPort = { observe(event) {
        try { required.observer.observe(event); } catch { /* Preserve the independent local destination. */ }
        if (event.operation !== 'approval.submit') return;
        try { capture({ event: { kind: 'trace', name: 'approval.submit', at: required.clock.now({}),
            correlationId: event.correlationId, traceId: event.traceId, outcome: event.outcome } }); }
        catch { /* Time/validation failures cannot change approval results. */ }
    } };
    return { capture, observer,
        recent(_input: Record<string, never>): RecentEvents { return recentEventsSchema.parse({ items }); },
        dispose(_input: Record<string, never>): void { disposed = true; items.length = 0; },
    };
}
