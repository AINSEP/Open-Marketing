// Transport-neutral agentic-capability port.
//
// This is the seam that keeps the rest of the daemon free of any
// CopilotKit / ag-ui knowledge. A "capability" is anything that can answer a
// turn — the marketing assistant today, and (per the roadmap) any project
// surface exposed to MCP / agents / web-mcp later. It only yields neutral
// `AguiEvent`s; the adapter in `./agent/base.ts` translates those into the
// ag-ui protocol that CopilotKit speaks. No file outside `agui-copilot/`
// should import `@ag-ui/*` or `@copilotkit/*`.

export interface AguiContextItem {
  /** Human-readable label the capability can match against (e.g. page context). */
  description: string;
  /** Opaque string payload — capabilities decide how to parse it (often JSON). */
  value: string;
}

export interface AguiMessage {
  role: string;
  content: unknown;
}

/** One turn's input, already normalized out of the ag-ui RunAgentInput shape. */
export interface AguiCapabilityInput {
  /** The latest user message, flattened to text. */
  prompt: string;
  threadId: string;
  runId: string;
  context: AguiContextItem[];
  messages: AguiMessage[];
}

/** Neutral events a capability streams for one turn. */
export type AguiEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; args: Record<string, unknown>; result: unknown }
  | { type: 'state'; snapshot: unknown };

/** A registerable unit of work behind the agui-copilot interface. */
export interface AguiCapability {
  /** Produce a stream of neutral events for a single turn. */
  run(input: AguiCapabilityInput): AsyncIterable<AguiEvent>;
}
