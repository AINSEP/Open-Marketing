import { it, expect } from 'vitest';
import { createDesktopApp } from '../src/index.js';
it('desktop import/factory is inert and remote close never stops service children', async () => {
 const calls: unknown[] = []; const stopped: string[] = [];
 const host = { async open(required: { studioUrl: string }) { calls.push(required); return { ok: true as const, value: undefined }; }, async close() { return { ok: true as const, value: undefined }; } };
 const children = { async start() { return { ok: true as const, value: undefined }; }, async stop(required: { child: 'server' | 'agent' }) { stopped.push(required.child); return { ok: true as const, value: undefined }; } };
 const app = createDesktopApp({ host, children, studioUrl: 'http://127.0.0.1:5173', mode: 'remote' }); expect(calls).toEqual([]); await app.start(); await app.stop(); expect(stopped).toEqual([]);
 expect((await app.reloadApi()).ok).toBe(false); expect(stopped).toEqual([]);
 expect(calls[0]).toMatchObject({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
});
it('defaults to local sandbox and reloads only the local server child', async () => {
 const calls: string[] = [];
 const host = { async open() { return { ok: true as const, value: undefined }; }, async close() { return { ok: true as const, value: undefined }; } };
 const children = { async start(required: { child: 'server' | 'agent' }) { calls.push('start:'+required.child); return { ok: true as const, value: undefined }; }, async stop(required: { child: 'server' | 'agent' }) { calls.push('stop:'+required.child); return { ok: true as const, value: undefined }; } };
 const app = createDesktopApp({ host, children, studioUrl: 'http://127.0.0.1:5173' });
 expect(calls).toEqual([]);
 expect(await app.reloadApi()).toMatchObject({ ok: true });
 expect(calls).toEqual(['stop:server', 'start:server']);
});
