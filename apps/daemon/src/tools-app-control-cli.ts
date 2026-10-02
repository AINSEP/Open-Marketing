// `om tools app-control ...` — agent-facing wrapper for frontend app-control.
//
// This is a `surface:'frontend'` tool: the actual work (navigating the app) is
// performed in the BROWSER by OMChatPane, which observes this tool call on the
// run's event stream and calls router.navigate. The wrapper itself is therefore
// a fire-and-forget acknowledgement — it validates args and exits 0 so the
// agent's Bash turn completes cleanly. It intentionally does NOT reach the
// daemon or mutate any state.

interface ToolCliResult {
  exitCode: number;
}

const APP_CONTROL_USAGE = `Usage:
  om tools app-control navigate --target <id>
      Ask the app to navigate to a page. The browser performs the navigation;
      this command only acknowledges. Valid <id> values are defined by the web
      navigation registry (e.g. home, design-systems, projects, integrations,
      plugins, automations, marketplace).

Agent runtime invocation:
  "$OM_NODE_BIN" "$OM_BIN" tools app-control navigate --target design-systems
`;

function readFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

export async function runAppControlToolCli(argv: string[]): Promise<ToolCliResult> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(APP_CONTROL_USAGE);
    return { exitCode: command ? 0 : 1 };
  }

  if (command === 'navigate') {
    const target = readFlag(rest, '--target') ?? rest.find((a) => !a.startsWith('-'));
    if (!target) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: { message: 'navigate requires --target <id>' } })}\n`,
      );
      return { exitCode: 1 };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, action: 'navigate', target })}\n`);
    return { exitCode: 0 };
  }

  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { message: `unknown app-control command: ${command}` } })}\n`,
  );
  return { exitCode: 1 };
}
