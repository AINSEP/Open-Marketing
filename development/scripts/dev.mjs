import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
/** Root dev entry supervises independent children. Services are authenticated unavailable shells, not business runtimes. */
const children = new Map();
function startService({ service, port }) {
 const child = spawn(process.execPath, ['--import', 'tsx', 'development/scripts/local-service.ts'], { detached: process.platform !== 'win32', stdio: ['ignore','inherit','inherit','pipe'] });
 child.stdio[3].end(JSON.stringify({ service, port, bearer: randomBytes(32).toString('hex') }));
 children.set(service, child);
 child.once('exit', () => children.delete(service));
 return child;
}
startService({ service: 'server', port: 4310 });
startService({ service: 'agent', port: 4311 });
const studio = spawn('corepack', ['pnpm','--filter','@open-marketing/studio','exec','vite','--host','127.0.0.1'], { detached: process.platform !== 'win32', stdio: 'inherit' });
children.set('studio', studio);
/** Development-only reload: stop the API child; the same agent OS process survives. */
process.on('SIGUSR2', () => { const server = children.get('server'); server?.once('exit', () => startService({ service: 'server', port: 4310 })); if (server) stopChild({ child: server }); });
function stopChild({ child }) { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); }
function shutdown({ ...required } = {}) { for (const child of children.values()) stopChild({ child }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
