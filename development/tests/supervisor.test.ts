import { it, expect } from 'vitest';
import { createSupervisor } from '../scripts/supervisor.js';
it('API reload leaves the same agent child alive', async () => {
 const stopped: string[] = []; const spawned: string[] = [];
 const processes = { async spawn(required: { child: 'server' | 'agent' }) { spawned.push(required.child); return { ok: true as const, value: { async stop() { stopped.push(required.child); return { ok: true as const, value: undefined }; } } }; } };
 const supervisor = createSupervisor({ processes });
 await supervisor.start({ child: 'server' }); await supervisor.start({ child: 'agent' });
 await supervisor.stop({ child: 'server' }); await supervisor.start({ child: 'server' });
 expect(stopped).toEqual(['server']); expect(spawned).toEqual(['server','agent','server']);
 await supervisor.stop({ child: 'agent' }); await supervisor.stop({ child: 'server' });
});
