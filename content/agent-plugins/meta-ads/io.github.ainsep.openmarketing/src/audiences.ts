import { z } from "zod";
import { capabilityCatalog } from "@open-marketing/contracts";
import type { CallContext, CallOptions, CapabilityInput, CapabilityOutput, Outcome, PluginCapability, PluginConfiguration } from "@open-marketing/contracts";
import { digest, failure, parse } from "./boundary.js";
import { sha256 } from "./capi-normalization.js";
import { vendorIdSchema } from "./commands.js";
import { adsGraphVersion } from "./instagram-fetch.js";
import type { createConfiguredDispatch } from "./instagram-fetch.js";
import type { MetaInstagramDispatch } from "./instagram.js";
import { boundContext } from "./read-capabilities.js";

const inputSchema = capabilityCatalog["audience.member.add.v1"].input.extend({ audienceId: vendorIdSchema, emailSha256: sha256 });
const audienceSchema = z.object({ account_id: vendorIdSchema, subtype: z.string().min(1).max(100) });
const receiptSchema = z.object({ audience_id: vendorIdSchema, num_received: z.number().int().nonnegative(), num_invalid_entries: z.number().int().nonnegative() });
type Result = CapabilityOutput<"audience.member.add.v1">;
type Request = { configuration: PluginConfiguration; dispatch: MetaInstagramDispatch; context: CallContext; input: CapabilityInput<"audience.member.add.v1"> };

/** Bind one inert upload handler; invalid canonical configuration fails before credentials or fetch.
 * @param required - The existing configured Graph dispatch result; no authority is granted here.
 * @returns One catalog handler, with explicit typed errors and no construction-time I/O. O(1) setup.
 * @example createAudienceCapabilities({ configured: createConfiguredDispatch(dependencies) })
 */
export function createAudienceCapabilities(required: { configured: ReturnType<typeof createConfiguredDispatch> }): { "audience.member.add.v1": PluginCapability<"audience.member.add.v1"> } {
  const { configured } = required;
  return { "audience.member.add.v1": (call, options) => {
    if (!configured.ok) return Promise.resolve(configured);
    return addMember({ ...configured.value, call }, options);
  } };
}

/** Validate binding/input, check audience ownership, then upload once. Contacts owns email hashing.
 * The host owns consent/erasure/grant checks and its final credentialed egress fence.
 * O(1) bounded work: one <=15s GET and at most one <=15s POST; existing 64KiB/1MiB limits apply.
 */
async function addMember(required: Pick<Request, "configuration" | "dispatch"> & { call: Parameters<PluginCapability<"audience.member.add.v1">>[0] }, optional?: CallOptions): Promise<Outcome<Result>> {
  try {
    const { scope, connectionId, accountId } = required.configuration;
    const context = boundContext({ binding: { scope, connectionId, accountId }, call: required.call });
    if (!context.ok) return context;
    const input = parse({ schema: inputSchema, input: required.call.input });
    if (!input.ok) return input;
    if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta audience upload cancelled" });
    const request = { ...required, context: context.value, input: input.value };
    const ownership = await requestAudience({ ...request, method: "GET" }, optional);
    if (!ownership.ok) return ownership;
    const audience = parse({ schema: audienceSchema, input: ownership.value });
    if (!audience.ok) return audience;
    if (audience.value.account_id !== accountId || audience.value.subtype !== "CUSTOM") return failure({ code: "forbidden", message: "Meta audience ownership or subtype mismatch" });
    if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta audience upload cancelled" });
    const receipt = await requestAudience({ ...request, method: "POST" }, optional);
    return decodeReceipt({ audienceId: input.value.audienceId, receipt });
  } catch { return failure({ code: "unavailable", message: "Meta audience boundary unavailable" }); }
}

/** Reuse guarded dispatch; the stable full-input digest binds both effects and the single session.
 * O(1), one bounded call; a thrown POST acknowledgement is uncertain and never retried.
 */
async function requestAudience(required: Request & { method: "GET" | "POST" }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { configuration, context, input, method } = required;
  const argumentsDigest = digest({ value: [context.correlationId, input.audienceId, input.emailSha256] });
  const session = { session_id: Number.parseInt(argumentsDigest.slice(0, 13), 16), batch_seq: 1, last_batch_flag: true };
  const parameters: Record<string, string> = method === "GET" ? { fields: "account_id,subtype" } : {
    payload: JSON.stringify({ schema: "EMAIL_SHA256", data: [input.emailSha256] }), session: JSON.stringify(session),
  };
  try {
    return await required.dispatch({ context, connectionId: configuration.connectionId, operationId: argumentsDigest,
      effect: { operationId: argumentsDigest, connectionId: configuration.connectionId, accountId: configuration.accountId, effects: [method === "GET" ? "read" : "write"], argumentsDigest, moneyExposure: null, requiredLimit: null },
      request: { method, endpoint: `https://graph.facebook.com/${adsGraphVersion}/${input.audienceId}${method === "POST" ? "/users" : ""}`, parameters }, timeoutMs: 15000,
    }, optional);
  } catch { return failure({ code: "unavailable", message: "Meta audience acknowledgement unavailable" }); }
}

/** Upload acceptance is not a match; preserve definite pre-send refusals, redact samples, never retry. O(1). */
function decodeReceipt(required: { audienceId: string; receipt: Outcome<unknown> }): Outcome<Result> {
  const unknown: Outcome<Result> = { ok: true, value: { audienceId: required.audienceId, status: "unknown" } };
  if (!required.receipt.ok) return required.receipt.error.code === "cancelled" || required.receipt.error.code === "forbidden" ? required.receipt : unknown;
  const receipt = receiptSchema.safeParse(required.receipt.value);
  if (!receipt.success) return unknown;
  if (receipt.data.num_invalid_entries > 0) return failure({ code: "invalid_input", message: "Meta rejected the audience identifier" });
  if (receipt.data.audience_id !== required.audienceId || receipt.data.num_received < 1) return unknown;
  return { ok: true, value: { audienceId: required.audienceId, status: "accepted" } };
}
