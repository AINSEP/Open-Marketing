import { it, expect } from 'vitest';
import { createServerApp } from '../src/index.js';
import { handleOmRequest } from '../src/inbound/om.js';
import { runAppControlToolCli } from '../src/cli/app-control.js';
import { createNodeBootIo } from '../src/composition/serve.js';
it('server factory is inert and lifecycle is explicit', async () => {
 let started = 0; const listener = { async start() { started++; return { ok: true as const, value: undefined }; }, async stop() { return { ok: true as const, value: undefined }; } };
 const grants = { async verify() { return { ok: false as const, error: { code: 'unauthenticated' as const, message: 'no authority', retryable: false } }; } };
 const app = createServerApp({ listener, grants, clock: { now: () => 0 } }); expect(started).toBe(0); await app.start({}); expect(started).toBe(1); await app.stop({});
});
it('concrete boot I/O and the custom dispatcher remain inert until lifecycle start', async () => {
 let started = 0;
 let stopped = 0;
 let ready = 0;
 const io = createNodeBootIo({ projectRoot: '/not-opened', studioRoot: '/not-opened/studio', ready: () => { ready++; } });
 const app = createServerApp({ listener: {
  async start({ handle }) { started++; expect(await handle({ path: '/health', method: 'GET' })).toEqual({ status: 200, body: 'fixture' }); return { ok: true, value: undefined }; },
  async stop() { stopped++; return { ok: true, value: undefined }; },
 }, handle: async () => ({ status: 200, body: 'fixture' }) });
 expect(io.projectRoot).toBe('/not-opened');
 expect([started, stopped, ready]).toEqual([0, 0, 0]);
 await app.start({});
 await app.stop({});
 expect([started, stopped, ready]).toEqual([1, 1, 0]);
});
it('OM requests authenticate before body is touched', async () => {
 let parsed = false; const request = { path: '/api/agent/v1/mcp', method: 'POST' as const, get body() { parsed = true; throw new Error('tainted'); } };
 const result = await handleOmRequest({ request, grants: { async verify() { return { ok: false as const, error: { code: 'unauthenticated' as const, message: 'missing', retryable: false } }; } }, clock: { now: () => 0 } });
 expect(result.status).toBe(401); expect(parsed).toBe(false);
});
it('app-control reports requested/pending from HTTP and rejects old destinations', async () => {
 const client = { async request(required: { actionId: string }) { return { ok: true as const, value: { actionId: required.actionId, status: 'pending' as const } }; } };
 expect(await runAppControlToolCli({ argv: ['navigate','--target','campaigns'], client, actionId: 'a' })).toEqual({ ok: true, value: { actionId: 'a', status: 'pending' } });
 expect((await runAppControlToolCli({ argv: ['navigate','--target','design-systems'], client, actionId: 'a' })).ok).toBe(false);
});
it('app-control rejects unvalidated or mismatched completion acknowledgements', async () => {
 for (const value of [{ actionId: 'a', status: 'completed' },{ actionId: 'other', status: 'pending' },{ actionId: 'a', status: 'completed', target: 'settings' }]) {
  const result = await runAppControlToolCli({ argv: ['navigate','--target=campaigns'], actionId: 'a', client: { async request() { return { ok: true, value }; } } });
  expect(result.ok).toBe(false);
 }
});
