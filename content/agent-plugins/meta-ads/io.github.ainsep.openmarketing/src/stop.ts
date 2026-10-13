import { z } from "zod";
import { digestSchema, effectEnvelopeSchema, epochSchema, haltStopRequestSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";

/** Backend mapping only; does not admit a tool, clear a local halt, or authorize execution. */
export interface MetaStopMapping { readonly bindingId: string; readonly calls: readonly { readonly entityId: string; readonly arguments: { readonly ad_account_id: string; readonly entity_id: string; readonly status: "PAUSED" } }[] }

/** Map a safety-issued closed halt permit to PAUSED-only payloads after exact envelope checks.
 * Generic updater/activation/budget fields cannot pass this boundary. Server verifies existing entity
 * ownership and keeps its halt fence through each egress. Batch identity matches safety's public digest.
 * @example mapMetaHaltStop({ permit, effect, pluginDigest, bindingId, now: clock.now({}) })
 * @complexity O(n log k) time/O(n) space, n<=100; no effects.
 */
export function mapMetaHaltStop(required: { permit: unknown; effect: unknown; pluginDigest: string; bindingId: string; now: number }): Outcome<MetaStopMapping> {
  const bounded = boundedJson({ input: { permit: required.permit, effect: required.effect }, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  const schema = z.strictObject({ permit: z.strictObject({ kind: z.literal("halt-stop"), request: haltStopRequestSchema, expiresAt: epochSchema }), effect: effectEnvelopeSchema });
  const parsed = parse({ schema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const { permit, effect } = parsed.value;
  const request = permit.request;
  if (!digestSchema.safeParse(required.pluginDigest).success || request.pluginDigest !== required.pluginDigest || request.bindingId !== required.bindingId) return failure({ code: "forbidden", message: "Meta stop binding mismatch" });
  if (!Number.isSafeInteger(required.now) || required.now < 0 || required.now >= permit.expiresAt) return failure({ code: "expired", message: "Meta halt permit expired" });
  if (!stopEffectMatches({ request, effect })) return failure({ code: "forbidden", message: "Meta halt mapping permits stop effects only" });
  const ids = parse({ schema: z.array(vendorIdSchema).min(1).max(100).refine(value => new Set(value).size === value.length), input: request.entityIds });
  if (!ids.ok) return ids;
  if (!vendorIdSchema.safeParse(request.adAccountId).success) return failure({ code: "invalid_input", message: "Meta stop account invalid" });
  const argumentsDigest = digest({ value: { adAccountId: request.adAccountId, entityIds: request.entityIds, action: request.action } });
  if (argumentsDigest !== request.argumentsDigest) return failure({ code: "conflict", message: "Meta stop arguments changed" });
  return { ok: true, value: { bindingId: required.bindingId, calls: ids.value.map(entityId => ({ entityId, arguments: { ad_account_id: request.adAccountId, entity_id: entityId, status: "PAUSED" } })) } };
}

/** Stop grants never carry money authority or additional effects. @complexity O(1). */
function stopEffectMatches(required: { request: z.infer<typeof haltStopRequestSchema>; effect: z.infer<typeof effectEnvelopeSchema> }): boolean {
  const { request, effect } = required;
  return effect.effects.length === 1 && effect.effects[0] === "halt_stop" && effect.moneyExposure === null && effect.requiredLimit === null && effect.accountId === request.adAccountId && effect.operationId === request.operationId && effect.connectionId === request.connectionId && effect.argumentsDigest === request.argumentsDigest;
}
