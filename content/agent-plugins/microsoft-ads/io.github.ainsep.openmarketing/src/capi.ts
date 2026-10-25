/** Narrow, server-only enhanced offline conversions; upload acceptance never implies attribution. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, ServiceContext } from "@open-marketing/contracts";
import { request } from "./commands.js";
import { boundInput } from "./campaign-translation.js";
import { configurationSchema, requestMicrosoftAds } from "./transport.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsIoDependencies } from "./ports.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema, destination: idSchema, purpose: idSchema,
  identifiers: z.strictObject({ email: hash }), identifierDigests: z.strictObject({ email: hash }) });
const grantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema, accountId: idSchema, definitionIds: z.array(idSchema).min(1).max(16),
  destination: idSchema, purpose: idSchema, payloadSchema: idSchema, payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
const requestSchema = z.strictObject({ context: z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema }), event: eventSchema, grant: grantSchema, deliveryId: idSchema });
const goalSchema = z.strictObject({ name: z.string().trim().min(1).max(100), createdAt: epochSchema, enhancedConversionsEnabled: z.literal(true) });
const capiConfigurationSchema = configurationSchema.extend({ mode: z.enum(["production-server", "local-sandbox", "read-only"]), destination: idSchema, purpose: idSchema, payloadSchema: idSchema,
  conversionGoals: z.record(idSchema, goalSchema).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100) });
export type MicrosoftAdsConversionConfiguration = z.infer<typeof capiConfigurationSchema>;
export type MicrosoftAdsConversionRequest = z.infer<typeof requestSchema>;
export interface MicrosoftAdsConversionOutcome { status: "delivered" | "unknown" }
export interface MicrosoftAdsConversionPayload { OfflineConversions: { ConversionName: string; ConversionTime: string; HashedEmailAddress: string }[] }
/** Existing measure/outbox authority ABI. Recheck account-owned existing goal and enhanced-conversion
 * eligibility, committed identifier evidence, live consent/grant/halt and admission. Claim deliveryId
 * plus exact payload once; append egress audit. isCurrent must remain live through the fetch call.
 */
export interface MicrosoftAdsConversionAuthority {
  dispatch(required: { context: ServiceContext; event: MicrosoftAdsConversionRequest["event"]; grant: MicrosoftAdsConversionRequest["grant"]; deliveryId: string; configuration: MicrosoftAdsConversionConfiguration; payload: MicrosoftAdsConversionPayload;
    execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<MicrosoftAdsConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<MicrosoftAdsConversionOutcome>>;
}
export type MicrosoftAdsConversionDependencies = Omit<MicrosoftAdsIoDependencies, "configuration"> & { configuration: MicrosoftAdsConversionConfiguration; authority: MicrosoftAdsConversionAuthority };
export interface MicrosoftAdsConversionBackend {
  deliver(required: MicrosoftAdsConversionRequest, optional?: CallOptions): Promise<Outcome<MicrosoftAdsConversionOutcome>>;
  reconcile(required: MicrosoftAdsConversionRequest, optional?: CallOptions): Promise<Outcome<MicrosoftAdsConversionOutcome>>;
}
type Prepared = { input: MicrosoftAdsConversionRequest; configuration: MicrosoftAdsConversionConfiguration; payload: MicrosoftAdsConversionPayload };

/** Deliver one authorized email digest to an existing goal; never resubmit an uncertain delivery.
 * @param required - Injected host effects, account-owned goal evidence and current measure authority.
 * @returns Inert backend with explicit preflight failures and accepted/unknown receipts.
 * @example createMicrosoftAdsConversionBackend({ configuration, authority, credentials, fetch, clock, timeoutSignal, observer })
 * @complexity O(b<=64KiB), <=100 mappings; one <=15s/1MiB RPC and zero retries.
 */
export function createMicrosoftAdsConversionBackend(required: MicrosoftAdsConversionDependencies): MicrosoftAdsConversionBackend {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async deliver(input, options) {
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      const result = await dispatch({ dependencies, prepared: prepared.value }, options);
      observe({ dependencies, context: prepared.value.input.context, result });
      return result;
    },
    async reconcile(input, options) {
      const prepared = prepare({ dependencies, input }, options);
      return prepared.ok ? unknown() : prepared;
    },
  };
}

/** Strict event keys reject raw PII/click IDs; snapshot exact payload before any host await. */
function prepare(required: { dependencies: MicrosoftAdsConversionDependencies; input: MicrosoftAdsConversionRequest }, optional?: CallOptions): Outcome<Prepared> {
  if (!required.dependencies.configuration.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: { input: required.input, configuration: required.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = z.strictObject({ input: requestSchema, configuration: capiConfigurationSchema }).safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const checked = checkAuthority({ ...parsed.data, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  const { input, configuration } = parsed.data;
  return { ok: true, value: { input, configuration, payload: { OfflineConversions: [{ ConversionName: configuration.conversionGoals[input.event.definitionId].name, ConversionTime: new Date(input.event.occurredAt).toISOString(), HashedEmailAddress: input.event.identifiers.email }] } } };
}

/** Local checks narrow input; only the host can establish live consent, halt and goal ownership. */
function checkAuthority(required: { input: MicrosoftAdsConversionRequest; configuration: MicrosoftAdsConversionConfiguration; now: number }): Outcome<void> {
  const { input, configuration, now } = required;
  if (!configuration.admitted || configuration.mode !== "production-server" || !configuration.accountId || !configuration.customerId) return failure({ code: "forbidden" });
  if (!grantMatches({ input, configuration }) || input.grant.revoked || now >= input.grant.expiresAt) return failure({ code: "forbidden" });
  if (!Number.isSafeInteger(now) || now < input.event.occurredAt || now - input.event.occurredAt > 90 * 86400000 || now > 8640000000000000) return failure({ code: "expired" });
  const goal = Object.hasOwn(configuration.conversionGoals, input.event.definitionId) ? configuration.conversionGoals[input.event.definitionId] : undefined;
  if (!goal || now - goal.createdAt < 7200000) return failure({ code: "not_implemented" });
  return { ok: true, value: undefined };
}
/** Scope/account/definition/purpose/destination/schema all bind this exact delivery. */
function grantMatches(required: { input: MicrosoftAdsConversionRequest; configuration: MicrosoftAdsConversionConfiguration }): boolean {
  const { input: { context, event, grant }, configuration } = required;
  return isDeepStrictEqual(context.scope, configuration.scope) && isDeepStrictEqual(grant.scope, configuration.scope)
    && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === configuration.destination && event.destination === configuration.destination
    && grant.purpose === configuration.purpose && event.purpose === configuration.purpose
    && grant.payloadSchema === configuration.payloadSchema && grant.definitionIds.includes(event.definitionId);
}

/** One durable host claim. The final fetch wrapper rechecks authority after both secret reads.
 * Unknown egress or lost host receipt stays unknown, never retryable. @complexity One fixed RPC.
 */
async function dispatch(required: { dependencies: MicrosoftAdsConversionDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<MicrosoftAdsConversionOutcome>> {
  const { dependencies, prepared } = required;
  let executed = false;
  let sent = false;
  try {
    return await dependencies.authority.dispatch({ context: structuredClone(prepared.input.context), event: structuredClone(prepared.input.event), grant: structuredClone(prepared.input.grant), deliveryId: prepared.input.deliveryId, configuration: structuredClone(prepared.configuration), payload: structuredClone(prepared.payload), execute: async fence => {
      if (executed) return failure({ code: "conflict" });
      executed = true;
      const fetch: typeof dependencies.fetch = async (url, init) => {
        const checked = checkAuthority({ input: prepared.input, configuration: prepared.configuration, now: dependencies.clock.now({}) });
        if (!checked.ok || !fence.isCurrent() || optional?.signal?.aborted) throw new Error("Microsoft conversion authority changed");
        sent = true;
        return dependencies.fetch(url, init);
      };
      const response = await requestMicrosoftAds({ dependencies: { ...dependencies, configuration: prepared.configuration, fetch }, request: request({ service: "CampaignManagement", path: "OfflineConversions/Apply", body: prepared.payload }) }, optional);
      if (!response.ok) return sent ? unknown() : response;
      const parsed = z.object({ PartialErrors: z.array(z.unknown()).max(1000).nullable() }).safeParse(response.value);
      if (!parsed.success || (parsed.data.PartialErrors?.length ?? 0) > 0) return unknown();
      return { ok: true, value: { status: "delivered" } };
    } }, optional);
  } catch { return sent ? unknown() : failure({ code: "forbidden" }); }
}
/** Reconciliation has no documented email-only lookup/deduplication; do not make a vendor call. */
function unknown(): Outcome<MicrosoftAdsConversionOutcome> { return { ok: true, value: { status: "unknown" } }; }
/** Correlated outcome only; identifier digests/tokens/goal names never enter telemetry. */
function observe(required: { dependencies: MicrosoftAdsConversionDependencies; context: ServiceContext; result: Outcome<MicrosoftAdsConversionOutcome> }): void {
  try { required.dependencies.observer.observe({ operation: "microsoft-ads.conversions", outcome: required.result.ok ? required.result.value.status : required.result.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId }); }
  catch { /* Durable audit remains the host's responsibility. */ }
}
