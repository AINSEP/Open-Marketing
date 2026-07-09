import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DAEMON_PORT = process.env.OD_DAEMON_PORT ?? '5288';
const VITE_PORT = process.env.OD_VITE_PORT ?? '5274';
const DAEMON_HEALTH_URL = `http://127.0.0.1:${DAEMON_PORT}/api/health`;

let daemon: ChildProcess | null = null;
let vite: ChildProcess | null = null;
let shuttingDown = false;

function runSync(command: string, args: string[]): void {
  spawnSync(command, args, {
    stdio: 'ignore',
    env: process.env,
  });
}

function spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') return;
    console.error(`[dev-vite] ${name} exited (${signal ?? code}).`);
    void shutdown(code ?? 1);
  });

  return child;
}

async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (daemon?.exitCode != null) {
      throw new Error('daemon exited before it became healthy');
    }
    try {
      const response = await fetch(DAEMON_HEALTH_URL);
      if (response.ok) return;
    } catch {
      // Keep polling while the daemon builds and starts.
    }
    await delay(750);
  }
  throw new Error(`daemon did not become healthy at ${DAEMON_HEALTH_URL}`);
}

function killPort(port: string): void {
  const result = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  const pids = result.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pids.length > 0) {
    spawnSync('kill', ['-TERM', ...pids], { stdio: 'ignore' });
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  vite?.kill('SIGTERM');
  daemon?.kill('SIGTERM');
  runSync('pnpm', ['tools-dev', 'stop']);
  killPort(VITE_PORT);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  console.log('[dev-vite] stopping existing tools-dev runtimes');
  runSync('pnpm', ['tools-dev', 'stop']);
  killPort(VITE_PORT);

  console.log(`[dev-vite] starting daemon on http://127.0.0.1:${DAEMON_PORT}`);
  daemon = spawnLogged('daemon', 'pnpm', ['tools-dev', 'run', 'daemon', '--daemon-port', DAEMON_PORT]);
  await waitForDaemon();

  console.log(`[dev-vite] daemon healthy; starting Vite on http://localhost:${VITE_PORT}`);
  vite = spawnLogged(
    'vite',
    'pnpm',
    ['--filter', '@open-design/web', 'dev:vite'],
    {
      ...process.env,
      OD_DAEMON_URL: `http://127.0.0.1:${DAEMON_PORT}`,
    },
  );
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  void shutdown(1);
});
