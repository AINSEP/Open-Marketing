import { notImplemented } from "@open-marketing/contracts";
import type { JiniRuntimePort } from "../ports.js";
/** Removable runtime seam. No presumed Jini export, executor, vendor configuration or shell. j22 owns adoption. */
export function createUnavailableRuntime(required: Record<string, never>): JiniRuntimePort { return {
 async startRun() { return notImplemented({ operation: "agent.startRun" }); },
 async cancelRun() { return notImplemented({ operation: "agent.cancelRun" }); },
 async events() { return notImplemented({ operation: "agent.events" }); },
}; }
