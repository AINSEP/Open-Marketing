// Explicit executable composition root; library imports stay inert.
import { runCli } from "../src/main.ts";
process.exitCode = await runCli({ args: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
