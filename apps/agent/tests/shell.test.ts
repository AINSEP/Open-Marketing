import { it, expect } from 'vitest';
import { createAgentApp } from '../src/index.js';
import { handleControl } from '../src/inbound/control.js';
import { createUnavailableRuntime } from '../src/runtime/unavailable.js';
it('agent factory is inert; missing loopback credentials deny before body parsing', async () => {
 let started = 0; let parsed = false; const listener = { async start() { started++; return { ok: true as const, value: undefined }; }, async stop() { return { ok: true as const, value: undefined }; } };
 const auth = { verify() { return { ok: false as const, error: { code: 'unauthenticated' as const, message: 'missing', retryable: false } }; } };
 const runtime = createUnavailableRuntime({}); const credential = { kind: 'service-control' as const, bearer: 'test-only' };
 const app = createAgentApp({ listener, auth, runtime, credential }); expect(started).toBe(0); await app.start({}); expect(started).toBe(1); await app.stop({});
 const result = await handleControl({ request: { path: '/internal/v1/runs', method: 'POST', get body() { parsed = true; throw new Error('tainted'); } }, auth, credential, runtime });
 expect(result.status).toBe(401); expect(parsed).toBe(false);
});
