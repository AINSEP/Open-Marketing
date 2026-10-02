import type { ElectronHostPort, ChildSupervisorPort } from "../ports.js";
import type { Outcome } from "@open-marketing/contracts";
/** Electron is injected by j23. Mode defaults to local sandbox; children have independent lifetimes.
 * @returns An inert lifecycle. API reload affects only the local server and denies remote ownership.
 * @complexity O(1) wrapper time/space, excluding injected lifecycle calls.
 */
export function createDesktopApp(required: { host: ElectronHostPort; children: ChildSupervisorPort; studioUrl: string; mode?: "local-sandbox" | "remote" }) {
 const supervision = { children: required.children, mode: required.mode ?? "local-sandbox" };
 return { start: () => required.host.open({ studioUrl: required.studioUrl, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } }), stop: () => required.host.close({}), reloadApi: () => reloadLocalApi(supervision) };
}
async function reloadLocalApi(required: { children: ChildSupervisorPort; mode: "local-sandbox" | "remote" }): Promise<Outcome<void>> {
 if (required.mode !== "local-sandbox") return { ok: false, error: { code: "forbidden", message: "Remote service lifetime is not desktop-owned", retryable: false } };
 const stopped = await required.children.stop({ child: "server" });
 if (!stopped.ok) return stopped;
 return required.children.start({ child: "server" });
}
