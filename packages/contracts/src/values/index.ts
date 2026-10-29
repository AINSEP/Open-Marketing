import { z } from "zod";
/** Pure shared values; schemas reject unknown authority-bearing fields. */
export const idSchema = z.string().min(1).max(256);
export const epochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const moneySchema = z.strictObject({ minorUnits: epochSchema, currency: z.string().regex(/^[A-Z]{3}$/) });
export const timeWindowSchema = z.strictObject({ start: epochSchema, end: epochSchema }).refine(value => value.start < value.end);
export const scopeSchema = z.strictObject({ ownerId: idSchema, workspaceId: idSchema });
export const principalSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("owner"), ownerId: idSchema }), z.strictObject({ kind: z.literal("agent"), agentInstanceId: idSchema, runId: idSchema }), z.strictObject({ kind: z.literal("service"), serviceId: idSchema })]);
export const appErrorSchema = z.strictObject({ code: z.enum(["not_implemented", "invalid_input", "unauthenticated", "forbidden", "unavailable", "conflict", "cancelled", "expired", "protocol_mismatch", "limit_exceeded"]), message: z.string().max(1024), retryable: z.boolean() });
export type AppError = z.infer<typeof appErrorSchema>;
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };
export type Scope = z.infer<typeof scopeSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type Money = z.infer<typeof moneySchema>;
export type TimeWindow = z.infer<typeof timeWindowSchema>;
export type OperationId = string;
export const callContextSchema = z.strictObject({ scope: scopeSchema, principal: principalSchema, correlationId: idSchema, traceId: idSchema, runId: idSchema.optional() });
export type CallContext = z.infer<typeof callContextSchema>;
/** Service identity and trace data only; parsing conveys no execution authority. */
export const serviceContextSchema = z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema });
export type ServiceContext = z.infer<typeof serviceContextSchema>;
export interface CallOptions { readonly signal?: AbortSignal }
export interface ClockPort { now(required: Record<string, never>): number }
export interface IdPort { next(required: Record<string, never>): string }
export interface ObserverEvent { readonly operation: string; readonly outcome: string; readonly correlationId: string; readonly traceId: string; readonly runId?: string }
export interface ObserverPort { observe(required: ObserverEvent): void }
export const pageQuerySchema = z.strictObject({ limit: z.number().int().min(1).max(100), cursor: idSchema.optional() });
export type PageQuery = z.infer<typeof pageQuerySchema>;
export interface Page<T> { readonly items: readonly T[]; readonly cursor: string | null }
/** Explicit unavailable result. Never grants authority or performs effects. @example notImplemented({ operation: "jobs.enqueue" }) */
export function notImplemented<T>(required: { operation: string }): Outcome<T> { return { ok: false, error: { code: "not_implemented", message: required.operation + " is not implemented", retryable: false } }; }
/** Schema parsing maps tainted boundary data to stable errors without leaking it. @complexity Schema-dependent bounded traversal. */
export function parseBoundary<T>(required: { schema: z.ZodType<T>; input: unknown }): Outcome<T> {
 const parsed = required.schema.safeParse(required.input);
 if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Boundary validation failed", retryable: false } };
 return { ok: true, value: parsed.data };
}

/** Sort object keys recursively, preserving array order; depth is checked even for leaves.
 * @complexity O(n log n) time, O(n) space for validated JSON.
 */
function canonicalValue(required: { value: unknown; depth: number }): unknown {
 if (required.depth > 16) throw new Error("JSON depth exceeds 16");
 if (Array.isArray(required.value)) return required.value.map(value => canonicalValue({ value, depth: required.depth + 1 }));
 if (required.value === null || typeof required.value !== "object") return required.value;
 const record = required.value as Record<string, unknown>;
 return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue({ value: record[key], depth: required.depth + 1 })]));
}
/** Canonical JSON for argument digests; no effects or hashing.
 * Accepts JSON with serialized.length <=65,536 UTF-16 code units and depth <=16.
 * Returns invalid_input for non-JSON or bounds failures, without exposing input.
 * @example canonicalizeArguments({ arguments: { b: 1, a: 2 } }) // { ok: true, value: '{"a":2,"b":1}' }
 * @complexity O(n log n) time, O(n) space for accepted JSON; initial serialization precedes bounds checks.
 */
export function canonicalizeArguments(required: { arguments: unknown }): Outcome<string> {
 try {
  const serialized = JSON.stringify(required.arguments);
  if (!serialized || serialized.length > 65_536) return { ok: false, error: { code: "invalid_input", message: "Arguments exceed JSON bounds", retryable: false } };
  const parsed = z.json().safeParse(required.arguments);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Arguments must be JSON", retryable: false } };
  const canonical = JSON.stringify(canonicalValue({ value: parsed.data, depth: 0 }));
  return { ok: true, value: canonical };
 } catch { return { ok: false, error: { code: "invalid_input", message: "Arguments exceed JSON bounds", retryable: false } }; }
}

const exactJsonInput = z.strictObject({ text: z.string().max(1048576) });
const exactJsonOptions = z.strictObject({ numericTextKeys: z.array(idSchema).max(100).optional() });
/** Parse <=1 MiB of JSON, recovering unsafe integer tokens and selected numeric fields as text.
 * Safe ordinary numbers retain their shape. Missing source evidence fails with protocol_mismatch;
 * callers must still schema-validate the returned data. No effects, O(b) time/space in bounded bytes.
 * @example parseExactIntegerJson({ text: '{"id":9007199254740993,"cost":1.25}' }, { numericTextKeys: ["cost"] })
 */
export function parseExactIntegerJson(required: { text: string }, optional?: { numericTextKeys?: readonly string[] }): Outcome<unknown> {
  const input = parseBoundary({ schema: exactJsonInput, input: required });
  if (!input.ok) return input;
  const options = parseBoundary({ schema: exactJsonOptions, input: optional ?? {} });
  if (!options.ok) return options;
  if (new TextEncoder().encode(input.value.text).byteLength > 1048576) return { ok: false, error: { code: "limit_exceeded", message: "JSON exceeds 1 MiB", retryable: false } };
  const keys = new Set(options.value.numericTextKeys);
  try {
    // Native JSON reviver ABI: source is supplied before floating-point precision is lost.
    const value: unknown = JSON.parse(input.value.text, (key: string, value: unknown, context?: { source?: string }) =>
      exactJsonNumber({ key, value, source: context?.source, keys }));
    return { ok: true, value };
  } catch {
    return { ok: false, error: { code: "protocol_mismatch", message: "Invalid JSON or unavailable numeric precision", retryable: false } };
  }
}

/** Foreign reviver wrapper; only source text can recover an unsafe integer or decimal field. */
function exactJsonNumber(required: { key: string; value: unknown; source?: string; keys: ReadonlySet<string> }): unknown {
  const { value, source } = required;
  if (typeof value !== "number") return value;
  if (required.keys.has(required.key)) {
    if (source === undefined) throw new Error("Numeric source unavailable");
    return source;
  }
  if (!Number.isFinite(value)) throw new Error("Non-finite JSON number");
  if (!Number.isInteger(value) || Number.isSafeInteger(value)) return value;
  if (source === undefined || !/^-?(0|[1-9]\d*)$/.test(source)) throw new Error("Exact integer source unavailable");
  return source;
}

export const campaignKeySchema = z.strictObject({ pluginId: idSchema, accountId: idSchema, vendorCampaignId: idSchema });
export type CampaignKey = z.infer<typeof campaignKeySchema>;
const encodedKey = z.string().max(256).regex(/^ck1:[A-Za-z0-9_-]+$/);
const keyParts = z.tuple([idSchema, idSchema, idSchema]);
/** Encode UTF-8 JSON [plugin,account,campaign] as canonical unpadded base64url, <=256 chars.
 * Returns invalid_input on invalid/oversized keys, no effects. O(b) time/space in bounded bytes.
 * @example encodeCampaignKey({ key: { pluginId: "ads", accountId: "a", vendorCampaignId: "urn:1" } })
 */
export function encodeCampaignKey({ key }: { key: CampaignKey }): Outcome<string> {
  const parsed = parseBoundary({ schema: campaignKeySchema, input: key });
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const bytes = new TextEncoder().encode(JSON.stringify([value.pluginId, value.accountId, value.vendorCampaignId]));
  const encoded = "ck1:" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return parseBoundary({ schema: encodedKey, input: encoded });
}
/** Parse only canonical ck1 keys, rejecting invalid UTF-8/JSON/padding/aliases.
 * Returns invalid_input, no effects. O(b) time/space, input <=256 characters.
 * @example parseCampaignKey({ value: "ck1:WyJhIiwiYiIsImMiXQ" })
 */
export function parseCampaignKey({ value }: { value: unknown }): Outcome<CampaignKey> {
  const parsed = parseBoundary({ schema: encodedKey, input: value });
  if (!parsed.ok) return parsed;
  try {
    const binary = atob(parsed.value.slice(4).replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    const parts = keyParts.parse(JSON.parse(json));
    const key = { pluginId: parts[0], accountId: parts[1], vendorCampaignId: parts[2] };
    const canonical = encodeCampaignKey({ key });
    if (canonical.ok && canonical.value === value) return { ok: true, value: key };
  } catch { /* Invalid encodings are ordinary boundary failures. */ }
  return { ok: false, error: { code: "invalid_input", message: "Invalid campaign key", retryable: false } };
}
/** Descriptive server-derived actor reference; parsing grants no trust. Never contains a token secret. */
export const approverRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jini_user"), userId: idSchema }),
  z.strictObject({ kind: z.literal("local_token"), ownerId: idSchema, deviceId: idSchema, tokenId: idSchema }),
]);
export type ApproverRef = z.infer<typeof approverRefSchema>;
/** Barrier evidence only, never an execution permit. P0-2 owns policy and denial vocabulary. */
export const dispatchDecisionSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }), z.strictObject({ allowed: z.literal(false), reason: idSchema }),
]);
export type DispatchDecision = z.infer<typeof dispatchDecisionSchema>;
