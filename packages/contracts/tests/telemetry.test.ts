/** Written-only OB1 fixtures: strict privacy envelope and bounded local snapshots. */
import { expect, it } from 'vitest';
import { captureEventSchema, recentEventsSchema } from '../src/index.js';
const card = { cardId: 'card-1', operationId: 'operation-1' };
const trace = { correlationId: 'click-1', traceId: 'trace-1' };
const fixtures = [
    { kind: 'product', name: 'screen.viewed', at: 1, screen: '/addons/plugins' },
    { kind: 'product', name: 'approval.shown', at: 1, ...card },
    { kind: 'product', name: 'approval.clicked', at: 1, ...card, ...trace, choice: 'allow', durationMs: 20 },
    { kind: 'product', name: 'approval.expired', at: 1, ...card, durationMs: 20 },
    { kind: 'error', name: 'approval.invalid_card', at: 1, errorCode: 'invalid_card' },
    { kind: 'error', name: 'approval.submit_failed', at: 1, ...card, ...trace, errorCode: 'timeout' },
    { kind: 'error', name: 'studio.render_crash', at: 1, screen: 'settings', errorCode: 'render_crash' },
    { kind: 'trace', name: 'approval.submit', at: 1, ...trace, outcome: 'recorded' },
];
it.each(fixtures)('accepts $name and rejects undeclared data', event => {
    expect(captureEventSchema.parse(event)).toEqual(event);
    for (const key of ['arguments', 'argumentsDigest', 'email', 'token', 'message', 'stack', 'url', 'eventId', 'runId'])
        expect(captureEventSchema.safeParse({ ...event, [key]: 'private' }).success).toBe(false);
});
it('bounds identifiers, timestamps, durations, codes, choices, screens and snapshots', () => {
    for (const patch of [{ cardId: 'x'.repeat(257) }, { cardId: 'person@example.test' }, { at: -1 }, { durationMs: Infinity }, { choice: 'approve_all' }, { kind: 'trace' }])
        expect(captureEventSchema.safeParse({ ...fixtures[2], ...patch }).success).toBe(false);
    expect(captureEventSchema.safeParse({ ...fixtures[0], screen: '/private/path' }).success).toBe(false);
    expect(captureEventSchema.safeParse({ ...fixtures[4], cardId: 'rejected-input' }).success).toBe(false);
    expect(captureEventSchema.safeParse({ ...fixtures[5], errorCode: 'raw error' }).success).toBe(false);
    expect(recentEventsSchema.safeParse({ items: Array(100).fill(fixtures[0]) }).success).toBe(true);
    expect(recentEventsSchema.safeParse({ items: Array(101).fill(fixtures[0]) }).success).toBe(false);
    expect(recentEventsSchema.safeParse({ items: [], cursor: 'extra' }).success).toBe(false);
});
