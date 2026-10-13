import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { RemoteToolResult } from "@jini-ai/mcp/federation";
import type { ExternalToolResult } from "../types.js";
import { parseJson, validateResult } from "../validation.js";

const remoteResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string().max(262144) })).max(100),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

/** Validate before Jini's permissive projection; discard MCP metadata only after bounding it.
 * @returns Typed failure for unsupported content or invalid fields. @complexity O(n), n<=262144 bytes.
 */
export function parseRemoteResult(required: { input: unknown }): Outcome<z.infer<typeof remoteResultSchema>> {
  return parseJson({ schema: remoteResultSchema, input: required.input, maxBytes: 262144 });
}

/** Map a validated Jini result into the agent-safe OM envelope; no provider config or metadata.
 * Jini explicitly returns undefined optional fields, so omit those before strict JSON copying.
 * @returns Bounded text/JSON or typed failure. @complexity O(n) bounded result copying.
 */
export function mapRemoteResult(required: { raw: RemoteToolResult; operationId: string }): Outcome<ExternalToolResult> {
  const input = { content: required.raw.content,
    ...(required.raw.structuredContent === undefined ? {} : { structuredContent: required.raw.structuredContent }),
    ...(required.raw.isError === undefined ? {} : { isError: required.raw.isError }) };
  const parsed = parseRemoteResult({ input });
  if (!parsed.ok) return parsed;
  const content: unknown[] = parsed.value.content.map(item => ({ type: "text", text: item.text }));
  if (parsed.value.structuredContent !== undefined) content.push({ type: "json", data: parsed.value.structuredContent });
  return validateResult({ input: { operationId: required.operationId, status: parsed.value.isError ? "failed" : "succeeded", content }, operationId: required.operationId, maxBytes: 262144, maxContent: 100 });
}
