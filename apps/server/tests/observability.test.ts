/** Written-only OB1 fixtures; no provider, network, credentials, or live effects. */
import { expect, it } from 'vitest';
import { createRecentEvents } from '../src/recent-events.js';
const screen = { kind: 'product', name: 'screen.viewed', at: 1, screen: 'settings' };
it('retains the newest 100, isolates snapshots/instances, rejects data and disposes', () => {
    const buffer = createRecentEvents({});
    for (let at = 0; at < 101; at++) expect(buffer.capture({ event: { ...screen, at } }).ok).toBe(true);
    expect(buffer.recent({}).items.map(event => event.at)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    buffer.recent({}).items[0].at = 999;
    expect(buffer.recent({}).items[0].at).toBe(1);
    expect(buffer.capture({ event: { ...screen, token: 'private' } }).ok).toBe(false);
    expect(buffer.capture({ event: { get name() { throw new Error('fixture'); } } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(buffer.recent({}).items).toHaveLength(100);
    expect(createRecentEvents({}).recent({}).items).toEqual([]);
    buffer.dispose({});
    expect(buffer.recent({})).toEqual({ items: [] });
    expect(buffer.capture({ event: screen }).ok).toBe(false);
});
