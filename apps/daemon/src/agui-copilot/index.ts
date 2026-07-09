// Public surface of the agui-copilot module — the system-wide agentic
// interface (CopilotKit v2 + ag-ui) that fronts the daemon. The HTTP server
// mounts createAguiHttpHandler(); capabilities register themselves via
// registerCapability(); everything CopilotKit/ag-ui-specific stays inside.

export { createAguiHttpHandler, type AguiHttpHandler } from './http-adapter.js';
export { registerCapability, getRegisteredCapabilities } from './registry.js';
export type {
  AguiCapability,
  AguiCapabilityInput,
  AguiContextItem,
  AguiEvent,
  AguiMessage,
} from './types.js';
