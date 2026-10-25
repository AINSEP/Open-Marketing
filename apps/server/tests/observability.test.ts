/** Written-only OB1 fixtures; no provider, network, credentials, or live effects. */
import { expect, it } from 'vitest';
import type { ObserverEvent } from '@open-marketing/contracts';
import { createRecentEvents } from '../src/recent-events.js';
const screen = { kind: 'product', name: 'screen.viewed', at: 1, screen: 'settings' };
const completion: ObserverEvent = { operation: 'approval.submit', outcome: 'recorded', correlationId: 'click', traceId: 'trace' };
it('retains the newest 100, isolates snapshots/instances, rejects data and disposes', () => {
    const buffer = createRecentEvents({ clock: { now: () => 10 }, observer: { observe() {} } });
    for (let at = 0; at < 101; at++) expect(buffer.capture({ event: { ...screen, at } }).ok).toBe(true);
    expect(buffer.recent({}).items.map(event => event.at)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    buffer.recent({}).items[0].at = 999;
    expect(buffer.recent({}).items[0].at).toBe(1);
    expect(buffer.capture({ event: { ...screen, token: 'private' } }).ok).toBe(false);
    expect(buffer.capture({ event: { get name() { throw new Error('fixture'); } } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(buffer.recent({}).items).toHaveLength(100);
    expect(createRecentEvents({ clock: { now: () => 10 }, observer: { observe() {} } }).recent({}).items).toEqual([]);
    buffer.dispose({});
    expect(buffer.recent({})).toEqual({ items: [] });
    expect(buffer.capture({ event: screen }).ok).toBe(false);
});
it('fans out only approval completion locally and preserves the original observer', () => {
    const forwarded: ObserverEvent[] = [];
    const buffer = createRecentEvents({ clock: { now: () => 10 }, observer: { observe(event) { forwarded.push(event); } } });
    buffer.observer.observe({ ...completion, operation: 'server.http.request' }); buffer.observer.observe(completion);
    expect(forwarded).toHaveLength(2);
    buffer.observer.observe({ ...completion, outcome: 'raw-error-message' });
    expect(buffer.recent({}).items).toEqual([{ kind: 'trace', name: 'approval.submit', at: 10, correlationId: 'click', traceId: 'trace', outcome: 'recorded' }]);
});
it('isolates throwing destinations and clock failures without retaining private observer fields', () => {
    const buffer = createRecentEvents({ clock: { now: () => 10 }, observer: { observe() { throw new Error('fixture'); } } });
    expect(() => buffer.observer.observe({ ...completion, runId: 'private' })).not.toThrow();
    expect(buffer.recent({}).items[0]).not.toHaveProperty('runId');
    const forwarded: ObserverEvent[] = [];
    const broken = createRecentEvents({ clock: { now() { throw new Error('fixture'); } }, observer: { observe(event) { forwarded.push(event); } } });
    expect(() => broken.observer.observe(completion)).not.toThrow();
    expect(forwarded).toEqual([completion]); expect(broken.recent({}).items).toEqual([]);
});
