import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, generationApprovalRequirementSchema, generationCostQuoteSchema, idSchema, moneySchema, parseBoundary } from "@open-marketing/contracts";
import type { AppError, CallContext, Outcome, GenerationCostQuote } from "@open-marketing/contracts";
import type { GenerationRequest, GenerationStatus, GenerationReceipt, GenerationProvenance } from "./types.js";

/** Strict request boundary. Depth/size are checked before recursive schema validation. */
export const generationRequestSchema = z.strictObject({
  capabilityId: idSchema, operationId: idSchema, argumentsDigest: digestSchema,
  configurationDigest: digestSchema, prompt: z.string().min(1).max(32_768),
  surface: z.enum(["image", "video", "audio"]), model: idSchema,
  seed: z.number().int().min(0).max(4_294_967_295).nullable(),
  maxAttempts: z.number().int().min(1).max(120), deadlineAt: epochSchema,
  parameters: z.record(z.string().max(256), z.json()), rightsEvidenceId: idSchema,
  vendorTermsDigest: digestSchema.nullable(), approvalId: idSchema.optional(),
});
/** Bounded polling boundary shared by service and adapter. */
export const pollRequestSchema = z.strictObject({ leaseOwner: idSchema, leaseMs: z.number().int().min(1000).max(60_000), limit: z.number().int().min(1).max(100), cursor: idSchema.optional() });
/** Dispatch receipts must identify the durable provider operation, unlike an enqueue receipt. */
export const dispatchReceiptSchema = z.strictObject({ generationId: idSchema, operationId: idSchema, asyncOperationId: idSchema, status: z.enum(["pending", "succeeded"]) });
/** Append-only money boundary. Negative/refund inference is deliberately absent. */
export const costSchema = z.strictObject({ observationId: idSchema, generationId: idSchema, operationId: idSchema, amount: moneySchema, kind: z.enum(["estimated", "actual", "correction"]), correctionOf: idSchema.optional() }).refine(value => (value.kind === "correction") === (value.correctionOf !== undefined));
const resultSchema = z.strictObject({ bytesBase64: z.string().max(22_369_624).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), providerNote: z.string().max(4096), suggestedExt: z.string().max(16).optional() });
/** Media boundary validates bounded payload shape; guarded URL fetching remains media-owned. */
export const generationOutputSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("bytes"), result: resultSchema }), z.strictObject({ kind: z.literal("url"), sourceUrl: z.url().max(4096), expectedDigest: digestSchema })]);
/** Late verification must name the exact durable operation and known provider handle. */
export const generationCompletionSchema = z.strictObject({ asyncOperationId: idSchema, providerJobId: idSchema, output: generationOutputSchema })
  .refine(value => value.output.kind !== "bytes" || value.output.result.bytesBase64.length > 0);
/** Original generation/rights evidence is retained independently of an imported asset. */
export const provenanceSchema = z.strictObject({ operationId: idSchema, generationId: idSchema, prompt: z.string().min(1).max(32_768), model: idSchema, seed: z.number().int().min(0).max(4_294_967_295).nullable(), quoteId: idSchema, vendorTermsDigest: digestSchema.nullable(), rightsEvidenceId: idSchema, assetId: idSchema.optional() });
/** Validates tainted Jini rows before they can become provenance or assets. Credentials are not a row field. */
export const operationSchema = z.strictObject({
  schemaVersion: z.literal(1), id: idSchema, providerId: idSchema, routeKey: idSchema, ownerRef: z.string().min(1).max(1024),
  status: z.enum(["submitted", "polling", "succeeded", "failed", "unknown"]), attempts: epochSchema,
  maxAttempts: z.number().int().min(1).max(120), deadlineAt: epochSchema, nextPollAt: epochSchema,
  leaseOwner: idSchema.nullable(), leaseExpiresAt: epochSchema.nullable(),
  state: z.strictObject({ jobId: idSchema.optional() }).nullable(), result: resultSchema.nullable(),
  error: z.strictObject({ message: z.string().max(4096), status: z.number().int().optional(), code: z.string().max(256).optional() }).nullable(),
  createdAt: epochSchema, updatedAt: epochSchema,
});
/** Durable projection schema; a generation holds at most 100 observations and 16 assets. */
export const statusSchema = z.strictObject({
  generationId: idSchema, state: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "unknown"]),
  request: generationRequestSchema, approval: generationApprovalRequirementSchema,
  dispatchState: z.enum(["queued", "dispatching", "submitted"]), reservationId: idSchema.nullable(),
  asyncOperationId: idSchema.nullable(), revision: epochSchema, operation: operationSchema.nullable(),
  providerJobId: idSchema.nullable(), assetIds: z.array(idSchema).max(16), quote: generationCostQuoteSchema,
  actualCost: moneySchema.nullable(), costs: z.array(costSchema).max(100),
  verifiedCompletion: generationCompletionSchema.optional(),
});

/** Stable explicit failure, without tainted payloads. @complexity O(1). */
export function failure<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}
/** Success constructor. @complexity O(1). */
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }

type JsonBudget = { nodes: number; characters: number };
function encodeChildren(required: { entries: readonly unknown[]; depth: number; budget: JsonBudget }): string | null {
  const encoded: string[] = [];
  for (const value of required.entries) {
    const entry = encodeJson({ value, depth: required.depth + 1, budget: required.budget });
    if (entry === null) return null;
    encoded.push(entry);
  }
  return encoded.join(",");
}
function encodeRecord(required: { value: Record<string, unknown>; depth: number; budget: JsonBudget }): string | null {
  const entries: string[] = [];
  for (const key of Object.keys(required.value).sort()) {
    const encodedKey = encodeJson({ value: key, depth: required.depth + 1, budget: required.budget });
    const encodedValue = encodeJson({ value: required.value[key], depth: required.depth + 1, budget: required.budget });
    if (encodedKey === null || encodedValue === null) return null;
    entries.push(encodedKey + ":" + encodedValue);
  }
  return "{" + entries.join(",") + "}";
}
function encodeScalar(required: { value: unknown; budget: JsonBudget }): string | null {
  if (typeof required.value === "number" && !Number.isFinite(required.value)) return null;
  if (!["string", "number", "boolean"].includes(typeof required.value) && required.value !== null) return null;
  if (typeof required.value === "string" && required.value.length > 65_536) return null;
  const encoded = JSON.stringify(required.value);
  required.budget.characters += encoded.length;
  if (required.budget.characters > 65_536) return null;
  return encoded;
}
/** Canonical JSON walk. Bounds precede recursion and hashing; rejects cycles, functions and exotic objects.
 * @complexity O(n log n), O(n) space, at most 8192 nodes, 16 levels and 64KiB text.
 */
function encodeJson(required: { value: unknown; depth: number; budget: JsonBudget }): string | null {
  required.budget.nodes += 1;
  if (required.depth > 16 || required.budget.nodes > 8192) return null;
  if (Array.isArray(required.value)) {
    const encoded = encodeChildren({ entries: required.value, depth: required.depth, budget: required.budget });
    if (encoded === null) return null;
    return "[" + encoded + "]";
  }
  if (required.value === null || typeof required.value !== "object") return encodeScalar({ value: required.value, budget: required.budget });
  if (Object.getPrototypeOf(required.value) !== Object.prototype) return null;
  return encodeRecord({ value: required.value as Record<string, unknown>, depth: required.depth, budget: required.budget });
}
/** Hash the reviewed payload. Excludes the digest itself and approval handle, includes all generation bounds.
 * @example digestGenerationRequest({ request: draft })
 * @complexity O(n log n), O(n) space within bounded JSON.
 */
export function digestGenerationRequest(required: { request: Omit<GenerationRequest, "argumentsDigest"> | GenerationRequest }): Outcome<string> {
  if (required.request === null || typeof required.request !== "object") return failure({ code: "invalid_input", message: "Generation request must be an object" });
  const { argumentsDigest: _digest, approvalId: _approval, ...payload } = required.request as GenerationRequest;
  const encoded = encodeJson({ value: payload, depth: 0, budget: { nodes: 0, characters: 0 } });
  if (encoded === null || encoded.length > 65_536) return failure({ code: "invalid_input", message: "Generation arguments exceed JSON bounds" });
  return success({ value: createHash("sha256").update(encoded).digest("hex") });
}
/** Canonical equality of small evidence records; never used on media bytes. @complexity O(n log n), bounded. */
export function sameEvidence(required: { left: unknown; right: unknown }): boolean {
  const left = encodeJson({ value: required.left, depth: 0, budget: { nodes: 0, characters: 0 } });
  const right = encodeJson({ value: required.right, depth: 0, budget: { nodes: 0, characters: 0 } });
  return left !== null && left === right;
}
/** Boundary/context validation and digest check before any effect. @complexity O(n log n), bounded. */
export function parseGeneration(required: { context: CallContext; request: GenerationRequest; now: number }): Outcome<GenerationRequest> {
  if (!validContext({ context: required.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
  const digest = digestGenerationRequest({ request: required.request });
  if (!digest.ok) return digest;
  const parsed = parseBoundary({ schema: generationRequestSchema, input: required.request });
  if (!parsed.ok) return parsed;
  if (parsed.value.argumentsDigest !== digest.value) return failure({ code: "conflict", message: "Generation arguments digest does not match" });
  if (parsed.value.deadlineAt <= required.now) return failure({ code: "expired", message: "Generation deadline expired" });
  if (parsed.value.deadlineAt - required.now > 86_400_000) return failure({ code: "limit_exceeded", message: "Generation deadline exceeds one day" });
  return parsed;
}
/** Authenticated owner matches scope; other identities must be authenticated by server composition. @complexity O(1). */
export function validContext(required: { context: CallContext }): boolean {
  const parsed = callContextSchema.safeParse(required.context);
  if (!parsed.success) return false;
  if (parsed.data.principal.kind !== "owner") return true;
  return parsed.data.principal.ownerId === parsed.data.scope.ownerId;
}
/** Quote binding check. Unknown pricing remains safety's decision; creative does not calculate allowances. @complexity O(1). */
export function validateQuote(required: { request: GenerationRequest; quote: GenerationCostQuote; now: number }): Outcome<GenerationCostQuote> {
  const parsed = parseBoundary({ schema: generationCostQuoteSchema, input: required.quote });
  if (!parsed.ok) return parsed;
  if (parsed.value.argumentsDigest !== required.request.argumentsDigest) return failure({ code: "conflict", message: "Quote arguments drifted" });
  if (parsed.value.modelConfigurationDigest !== required.request.configurationDigest) return failure({ code: "conflict", message: "Quote configuration drifted" });
  if (parsed.value.expiresAt <= required.now || parsed.value.status === "expired") return failure({ code: "expired", message: "Generation quote expired" });
  return parsed;
}
/** Collision-free scoped identity for test adapters and operation ownership. @complexity O(1), bounded IDs. */
export function scopedKey(required: { context: CallContext; id: string }): string {
  return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId, required.id]);
}
/** Stable identities allow cost/import retries after any crash. @complexity O(n), bounded identifiers. */
export function evidenceId(required: { generationId: string; kind: string }): string {
  return createHash("sha256").update(JSON.stringify([required.generationId, required.kind])).digest("hex");
}
/** Receipt is honest about work still waiting for a worker. @complexity O(1). */
export function receipt(required: { status: GenerationStatus }): GenerationReceipt {
  return { generationId: required.status.generationId, operationId: required.status.request.operationId, asyncOperationId: required.status.asyncOperationId, status: required.status.state === "succeeded" ? "succeeded" : "pending" };
}
/** Original prompt/configuration and rights evidence survive failed generation. @complexity O(1). */
export function provenance(required: { status: GenerationStatus; assetId?: string }): GenerationProvenance {
  const request = required.status.request;
  return { generationId: required.status.generationId, operationId: request.operationId, prompt: request.prompt, model: request.model, seed: request.seed, quoteId: required.status.quote.quoteId, vendorTermsDigest: request.vendorTermsDigest, rightsEvidenceId: request.rightsEvidenceId, ...(required.assetId === undefined ? {} : { assetId: required.assetId }) };
}
/** Deep freeze a validated JSON snapshot; ports cannot mutate the reviewed arguments. @complexity O(n), bounded depth. */
export function freezeValue<T>(required: { value: T }): T {
  if (required.value === null || typeof required.value !== "object") return required.value;
  for (const value of Object.values(required.value)) freezeValue({ value });
  return Object.freeze(required.value);
}
