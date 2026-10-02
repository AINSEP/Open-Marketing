import { it, expect } from 'vitest';
import { createEventClient } from '../src/om-client/index.js';
const input = { runId: 'run-1', after: 0, path: '/api/agent/v1/runs/run-1/events', authorization: 'Bearer ' + 'x'.repeat(32) };
const event = { protocolVersion: 1, eventId: 'event-1', runId: 'run-1', sequence: 1, correlationId: 'correlation-1', traceId: 'trace-1', kind: 'started', payload: {} };
it('event client rejects arbitrary routes before transport and binds ordered events to the run', async () => {
 let calls = 0; const observed: unknown[] = [];
 const sse = { async *subscribe() { calls++; yield event; yield { ...event, eventId: 'event-2' }; } };
 const client = createEventClient({ sse, observer: { observe(required) { observed.push(required); } }, maxEvents: 10 });
 const denied = []; for await (const result of client.events({ ...input, path: 'https://vendor.invalid/' })) denied.push(result);
 expect(denied[0].ok).toBe(false); expect(calls).toBe(0);
 const results = []; for await (const result of client.events(input)) results.push(result);
 expect(results.map(result => result.ok)).toEqual([true,false]); expect(observed).toHaveLength(1);
});
it('event client rejects cross-run payload and enforces its event bound', async () => {
 const observer = { observe() {} };
 const wrong = createEventClient({ sse: { async *subscribe() { yield { ...event, runId: 'run-2' }; } }, observer, maxEvents: 10 });
 for await (const result of wrong.events(input)) expect(result.ok).toBe(false);
 const bounded = createEventClient({ sse: { async *subscribe() { yield event; yield { ...event, sequence: 2 }; } }, observer, maxEvents: 1 });
 const results = []; for await (const result of bounded.events(input)) results.push(result);
 expect(results.map(result => result.ok)).toEqual([true,false]);
});
