import { z } from "zod";
import { digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import type { MetaInvocation } from "./commands.js";
import type { MetaEvidencePort } from "./ports.js";

const primaryUrl = z.string().url().max(2048).refine(value => new URL(value).hostname === "developers.facebook.com");
/** A captured tools/list plus primary behavior evidence and host-owned account/plugin pins.
 * SDK evidence alone cannot certify a hosted tool. Output schemas are mandatory for this adapter.
 */
export const bindingSchema = z.strictObject({
  bindingId: idSchema, status: z.literal("verified"), scope: scopeSchema, connectionId: idSchema,
  accountId: z.string().regex(/^[1-9][0-9]{0,31}$/), pluginDigest: digestSchema,
  endpoint: z.literal("https://mcp.facebook.com/ads"), transport: z.literal("streamable-http"),
  toolName: z.string().regex(/^meta-ads\.[a-zA-Z0-9_-]{1,128}$/),
  operation: z.enum(["create-campaign", "create-adset", "create-ad", "activate", "pause", "set-campaign-cap", "set-daily-budget", "read-entities", "report"]),
  claims: z.array(z.string().min(1).max(128)).max(20), primarySourceUrl: primaryUrl,
  toolsListDigest: digestSchema, schemaFingerprint: digestSchema,
  inputSchema: z.record(z.string().max(256), z.json()), outputSchema: z.record(z.string().max(256), z.json()),
  verifiedAt: epochSchema, expiresAt: epochSchema,
});
export type MetaBinding = z.infer<typeof bindingSchema>;

/** Verify identity, freshness, behavior claim and exact captured schema digest before dispatch.
 * @example verifyBinding({ input: captured, request, claim: "exact-activation", pluginDigest, now })
 * @complexity O(s log k) time/O(s) space for <=64KiB schema evidence. No I/O.
 */
export function verifyBinding(required: { input: unknown; request: MetaInvocation; claim: string; pluginDigest: string; now: number }): Outcome<MetaBinding> {
  const bounded = boundedJson({ input: required.input, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  const parsed = parse({ schema: bindingSchema, input: bounded.value });
  if (!parsed.ok) return failure({ code: "unavailable", message: "Meta capability lacks verified primary/tool-schema evidence" });
  const binding = parsed.value;
  if (!matchesRequest({ binding, request: required.request, pluginDigest: required.pluginDigest })) return failure({ code: "forbidden", message: "Meta capability binding mismatch" });
  if (!Number.isSafeInteger(required.now) || required.now < binding.verifiedAt || required.now >= binding.expiresAt) return failure({ code: "expired", message: "Meta evidence expired or future-dated" });
  if (!binding.claims.includes(required.claim)) return failure({ code: "unavailable", message: "Required Meta behavior remains unverified" });
  const fingerprint = digest({ value: { inputSchema: binding.inputSchema, outputSchema: binding.outputSchema } });
  if (fingerprint !== binding.schemaFingerprint) return failure({ code: "protocol_mismatch", message: "Meta schema evidence drift" });
  return parsed;
}

/** Scope and each implementation pin must agree; schema checks cannot establish ownership. @complexity O(1). */
function matchesRequest(required: { binding: MetaBinding; request: MetaInvocation; pluginDigest: string }): boolean {
  const { binding, request } = required;
  return binding.scope.ownerId === request.context.scope.ownerId && binding.scope.workspaceId === request.context.scope.workspaceId && binding.connectionId === request.connectionId && binding.accountId === request.accountId && binding.pluginDigest === required.pluginDigest && binding.operation === request.command.kind;
}

/** Safe default for an unverified installation; enabling a plugin does not admit its tools.
 * @example createUnavailableMetaEvidence({})
 * @complexity O(1) per lookup; inert factory.
 */
export function createUnavailableMetaEvidence(_required: Record<string, never>): MetaEvidencePort {
  return { async resolve() { return failure({ code: "unavailable", message: "Meta hosted capability evidence has not been admitted" }); } };
}
