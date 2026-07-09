// Open Marketing execution engine — a self-contained CLI-agent detector +
// headless runner ported from Open-Marketing-old. It is intentionally
// decoupled from Open Design's own (much richer) agent runtime so the
// ag-ui CopilotKit layer can ship as an isolated module without entangling
// with the daemon's run/stream internals. v1 supports the headless CLIs
// (Claude, Codex); BYOK / OpenRouter / DB-backed campaigns were dropped.

import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// A code-agent the daemon knows how to detect on the host. The installed
// LLM CLIs (Claude Code, Codex, Gemini, …) are Open Marketing's execution
// engine, exactly as in Open Design.
export interface AgentDef {
  id: string;
  name: string;
  // Candidate binary names, in priority order. First one found on PATH wins.
  bins: string[];
  versionArgs: string[];
}

export type NotAvailableCause = 'not-found' | 'not-executable' | 'missing-target';

export interface DetectedAgent {
  id: string;
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  cause?: NotAvailableCause;
}

// The agent roster. Mirrors the common set Open Design scans for. Add an
// entry here to teach the daemon about a new CLI; detection is generic.
export const AGENT_DEFS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', bins: ['claude'], versionArgs: ['--version'] },
  { id: 'codex', name: 'Codex CLI', bins: ['codex'], versionArgs: ['--version'] },
  { id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], versionArgs: ['--version'] },
  { id: 'cursor-agent', name: 'Cursor Agent', bins: ['cursor-agent'], versionArgs: ['--version'] },
  { id: 'opencode', name: 'OpenCode', bins: ['opencode'], versionArgs: ['--version'] },
];

// Walk $PATH for an executable named `bin`. This is the load-bearing step:
// it's how we learn whether Claude / Codex / Gemini are installed. On
// Windows we also try PATHEXT suffixes.
async function resolveBinary(bin: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here / not executable — keep looking.
      }
    }
  }
  return null;
}

async function probe(def: AgentDef): Promise<DetectedAgent> {
  let resolved: string | null = null;
  for (const bin of def.bins) {
    resolved = await resolveBinary(bin);
    if (resolved) break;
  }
  if (!resolved) {
    return { id: def.id, name: def.name, available: false, path: null, version: null, cause: 'not-found' };
  }

  try {
    const { stdout } = await execFileP(resolved, def.versionArgs, { timeout: 4000 });
    const version = stdout.trim().split('\n')[0] || null;
    return { id: def.id, name: def.name, available: true, path: resolved, version };
  } catch (err) {
    // Classify like Open Design: distinguish "the OS refused to run it"
    // (broken shim / permissions) from "it ran but --version was unhappy".
    const code: unknown = (err as { code?: unknown }).code;
    if (code === 'EACCES' || code === 126) {
      return { id: def.id, name: def.name, available: false, path: resolved, version: null, cause: 'not-executable' };
    }
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 127) {
      return { id: def.id, name: def.name, available: false, path: resolved, version: null, cause: 'missing-target' };
    }
    return { id: def.id, name: def.name, available: true, path: resolved, version: null };
  }
}

// Probe every known agent concurrently. One adapter throwing must not
// collapse the whole list, so each probe is fault-isolated.
export async function detectAgents(): Promise<DetectedAgent[]> {
  return Promise.all(
    AGENT_DEFS.map((def) =>
      probe(def).catch(
        (): DetectedAgent => ({
          id: def.id,
          name: def.name,
          available: false,
          path: null,
          version: null,
          cause: 'not-found',
        }),
      ),
    ),
  );
}

// Headless invocation per CLI agent. Verified against the installed CLIs:
//   claude -p "<prompt>" [--model <m>]   → prints the response and exits
//   codex exec [-m <m>] "<prompt>"       → runs non-interactively
// Other detected agents aren't wired for headless yet — they throw a clear
// error rather than guessing flags.
function buildArgs(engineId: string, prompt: string, model?: string): string[] {
  switch (engineId) {
    case 'claude':
      return ['-p', prompt, ...(model ? ['--model', model] : [])];
    case 'codex':
      return ['exec', ...(model ? ['-m', model] : []), prompt];
    default:
      throw new Error(`Headless invocation not implemented for engine '${engineId}'`);
  }
}

// Spawn the CLI with stdin set to 'ignore' (→ /dev/null). This is load-bearing
// for `codex exec`: with a non-TTY stdin it otherwise blocks waiting for piped
// input and never returns. Ignoring stdin gives it immediate EOF.
function runProcess(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`engine timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // `claude -p` writes login prompts and usage-limit notices to STDOUT,
        // not stderr — so reporting stderr alone leaves "engine exited 1: "
        // with an empty cause. Surface the binary, exit code, and the TAIL of
        // both streams (the meaningful line is usually last) so the real
        // reason is visible in the RUN_ERROR event. Keep the "engine exited N"
        // prefix so existing log scraping still matches.
        const tail = (s: string) => (s.trim() ? s.trim().slice(-300) : '<empty>');
        reject(
          new Error(
            `engine exited ${code ?? 'null'} (bin=${bin}) | stderr: ${tail(stderr)} | stdout: ${tail(stdout)}`,
          ),
        );
      }
    });
  });
}

async function runCliEngine(
  binPath: string,
  engineId: string,
  prompt: string,
  model?: string,
): Promise<string> {
  return runProcess(binPath, buildArgs(engineId, prompt, model), 90_000);
}

export interface ChatResult {
  engineId: string;
  model: string | null;
  text: string;
}

// Dispatch a prompt to the chosen CLI engine and return its text. Throws a
// clear error when the engine isn't available (CLI not installed).
export async function runChat(req: { engineId: string; prompt: string; model?: string }): Promise<ChatResult> {
  const agents = await detectAgents();
  const agent = agents.find((a) => a.id === req.engineId);
  if (!agent) throw new Error(`Unknown engine '${req.engineId}'.`);
  if (!agent.available || !agent.path) {
    throw new Error(`Engine '${req.engineId}' is not available on this host.`);
  }
  const text = await runCliEngine(agent.path, req.engineId, req.prompt, req.model);
  return { engineId: req.engineId, model: req.model ?? null, text };
}
