import type { Outcome } from "@open-marketing/contracts";

/** Secure studio window. Open/close failures remain explicit boundary outcomes. */
export interface ElectronHostPort {
 open(required: { studioUrl: string; webPreferences: { contextIsolation: true; sandbox: true; nodeIntegration: false } }): Promise<Outcome<void>>;
 close(required: Record<string, never>): Promise<Outcome<void>>;
}

/** Readiness and replayable terminal observation of the desktop-owned server.
 * Listeners receive one exit outcome; unsubscribe releases an outstanding listener.
 * @example handle.onExit({ listener: outcome => console.log(outcome.ok) });
 */
export interface ServerReady {
 studioUrl: string;
 onExit(required: { listener: (outcome: Outcome<void>) => void }): () => void;
}

/** Owns only a local server process group. The server owns its agent. */
export interface ChildSupervisorPort {
 start(required: { child: "server" }): Promise<Outcome<ServerReady>>;
 stop(required: { child: "server" }): Promise<Outcome<void>>;
}
