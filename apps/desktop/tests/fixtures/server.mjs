/** Harmless executable fixture: loopback HTTP and owned descendants only, no vendor effects. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";

const scenario = basename(process.env.OM_STATE_ROOT);
if (process.env.OM_MODE !== "local-sandbox" || process.env.OM_HOST !== "127.0.0.1" || process.env.OM_PORT !== "0") process.exit(8);
if (scenario === "exit-before-ready") process.exit(7);
const server = createServer((_request, response) => response.end("<html><body>OM fixture</body></html>"));

function ready() {
 const line = `OM_READY ${JSON.stringify({ studioUrl: `http://127.0.0.1:${server.address().port}` })}\n`;
 if (scenario === "no-ready") return;
 if (scenario === "split") {
  process.stdout.write(line.slice(0, 12));
  setTimeout(() => process.stdout.write(line.slice(12)), 20);
  return;
 }
 process.stdout.write(line);
}

function listen() {
 server.listen(0, "127.0.0.1", ready);
}

if (scenario === "descendant") {
 const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
 child.once("message", pid => { writeFileSync(join(process.env.OM_STATE_ROOT, "descendant.pid"), String(pid)); listen(); });
} else listen();

process.on("SIGTERM", () => {
 if (scenario === "ignore-term") return;
 server.close(() => process.exit(0));
});
