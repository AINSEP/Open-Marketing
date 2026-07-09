import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { createCopilotNodeHandler } from '@copilotkit/runtime/v2/node';

import { CapabilityAgent } from './agent/base.js';
import { getRegisteredCapabilities } from './registry.js';

// CopilotKit's own `CopilotRuntime` types `intelligence` as optional, but the
// handler's `CopilotRuntimeLike` requires it. Under Open Design's stricter
// `exactOptionalPropertyTypes: true` tsconfig that surfaces as a TS2375
// mismatch; the instance is structurally valid, so we cast through the
// handler's expected runtime type rather than loosen the daemon's tsconfig.
type HandlerRuntime = Parameters<typeof createCopilotRuntimeHandler>[0]['runtime'];

// Build a CopilotKit v2 node handler from every registered capability. Each
// capability is wrapped in the generic CapabilityAgent adapter and exposed as
// an ag-ui agent under its id. Call this AFTER capabilities have registered
// (i.e. once at daemon start).
export function createCopilotNodeRuntimeHandler(): ReturnType<typeof createCopilotNodeHandler> {
  const agents: Record<string, CapabilityAgent> = {};
  for (const entry of getRegisteredCapabilities()) {
    agents[entry.id] = new CapabilityAgent(entry.id, entry.description, entry.capability);
  }

  const runtime = new CopilotRuntime({ agents });
  const fetchHandler = createCopilotRuntimeHandler({
    runtime: runtime as unknown as HandlerRuntime,
    basePath: '/api/copilotkit',
    mode: 'single-route',
    cors: true,
  });
  return createCopilotNodeHandler(fetchHandler);
}
