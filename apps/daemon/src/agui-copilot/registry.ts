import type { AguiCapability } from './types.js';

// In-process capability registry. This is the extension point for the
// "expose everything as an agentic API" roadmap: a new project surface
// implements AguiCapability and calls registerCapability() at module load,
// without touching the daemon HTTP server, the runtime, or the web app.
//
// Importing this module pulls in NO @copilotkit/@ag-ui code (only types), so
// domain modules can register without taking on the transport dependency.

export interface RegisteredCapability {
  id: string;
  description: string;
  capability: AguiCapability;
}

const capabilities = new Map<string, RegisteredCapability>();

export function registerCapability(
  id: string,
  description: string,
  capability: AguiCapability,
): void {
  capabilities.set(id, { id, description, capability });
}

export function getRegisteredCapabilities(): RegisteredCapability[] {
  return [...capabilities.values()];
}
