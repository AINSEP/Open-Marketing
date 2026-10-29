import { z } from "zod";
import { epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, ServiceContext } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { failure } from "./ports.js";
import type { PinterestDependencies } from "./ports.js";
import { boundInput, configurationSchema, requestPinterest, resolveCredential } from "./transport.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema,
  destination: idSchema, purpose: idSchema, identifiers: z.strictObject({ email: hash }), identifierDigests: z.strictObject({ email: hash }) });
const grantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema, accountId: vendorId,
  definitionIds: z.array(idSchema).min(1).max(16), destination: idSchema, purpose: idSchema, payloadSchema: idSchema, payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
const requestSchema = z.strictObject({ context: z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema }), event: eventSchema, grant: grantSchema, deliveryId: idSchema });
const sourceUrl = z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; });
const capiConfigurationSchema = configurationSchema.extend({ accountId: vendorId, mode: z.enum(["production-server", "local-sandbox", "read-only"]),
  destination: idSchema, purpose: idSchema, payloadSchema: idSchema,
  conversionRules: z.record(idSchema, z.strictObject({ eventName: z.literal("signup"), sourceUrl })).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100) });
/** Server maps open OM definitions to the single supported web signup path and exact source URL. */
export type PinterestCapiConfiguration = z.infer<typeof capiConfigurationSchema>;
/** Contacts owns email hashing and committed identifier evidence; no raw PII is accepted. */
export type PinterestConversionInput = z.infer<typeof eventSchema>;
/** Open definition IDs, bound to one account/connection/destination/purpose/schema. */
export type PinterestMeasurementGrant = z.infer<typeof grantSchema>;
/** deliveryId is the host outbox identity; eventId remains unchanged for vendor deduplication. */
export interface PinterestCapiRequest { context: ServiceContext; event: PinterestConversionInput; grant: PinterestMeasurementGrant; deliveryId: string }
/** A singleton web event; no extra identifiers or attribution metadata. */
export interface PinterestCapiPayload { data: [{ event_name: "signup"; action_source: "web"; event_id: string; event_time: number; event_source_url: string; opt_out: false; user_data: { em: [string] } }] }
/** Processed means per-event acceptance, never campaign attribution. Unknown is never resent. */
export interface PinterestConversionOutcome { status: "delivered" | "unknown" }
/** Host claims deliveryId + exact payload/version in the ONE jobs outbox, verifies contacts digests,
 * current consent, mapping ownership, mode, admission and grants AFTER token lookup; append egress
 * audit with delivery/correlation/trace IDs. execute is a host ABI; repeated claims never execute.
 */
export interface PinterestConversionAuthorityPort {
  dispatch(required: { context: ServiceContext; event: PinterestConversionInput; grant: PinterestMeasurementGrant; deliveryId: string; configuration: PinterestCapiConfiguration; payload: PinterestCapiPayload; execute: (required: { isCurrent: () => boolean }) => Promise<Outcome<PinterestConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<PinterestConversionOutcome>>;
}
/** Inert, server-only dependencies; guarded fetch retains the host's final egress fence. */
export type PinterestCapiDependencies = Omit<PinterestDependencies, "gateway" | "configuration"> & { configuration: PinterestCapiConfiguration; authority: PinterestConversionAuthorityPort };
/** Backend-only measurement methods, never assistant tools. */
export interface PinterestCapiBackend {
  deliver(required: PinterestCapiRequest, optional?: CallOptions): Promise<Outcome<PinterestConversionOutcome>>;
  reconcile(required: PinterestCapiRequest, optional?: CallOptions): Promise<Outcome<PinterestConversionOutcome>>;
}
interface Prepared { request: PinterestCapiRequest; configuration: PinterestCapiConfiguration; payload: PinterestCapiPayload }

/** One documented web signup POST under current measurement authority; reconciliation performs no I/O.
 * @param required - Explicit mappings, authority, broker and injected fetch/deadline/clock/observer.
 * @returns Typed preflight denial or delivered/unknown; uncertainty never permits resending.
 * @example createPinterestCapiBackend({ configuration, authority, credentials, fetch, deadline, clock, observer })
 * @complexity O(b) time/space, <=64KiB input, <=100 mappings, one <=15s/1MiB POST; no retries.
 */
export function createPinterestCapiBackend(required: PinterestCapiDependencies): PinterestCapiBackend {
  const dependencies = { ...required };
  return {
    async deliver(input, options) {
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      return dispatch({ dependencies, prepared: prepared.value }, options);
    },
    async reconcile(input, options) {
      const prepared = prepare({ dependencies, input }, options);
      return prepared.ok ? unknown() : prepared;
    },
  };
}
/** Snapshot all reviewed bytes before awaits. Unsupported mappings fail with zero credential/network I/O. O(b). */
function prepare(required: { dependencies: PinterestCapiDependencies; input: PinterestCapiRequest }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: { request: required.input, configuration: required.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const envelope = z.strictObject({ request: requestSchema, configuration: z.unknown() }).safeParse(bounded.value);
  if (!envelope.success) return failure({ code: "invalid_input" });
  const configuration = capiConfigurationSchema.safeParse(envelope.data.configuration);
  if (!configuration.success) return failure({ code: "not_implemented" });
  const request = envelope.data.request;
  const checked = checkAuthority({ request, configuration: configuration.data, now: required.dependencies.clock.now({}) });
  if (!checked.ok) return checked;
  const mapping = Object.hasOwn(configuration.data.conversionRules, request.event.definitionId) ? configuration.data.conversionRules[request.event.definitionId] : undefined;
  if (!mapping) return failure({ code: "not_implemented" });
  const payload: PinterestCapiPayload = { data: [{ event_name: mapping.eventName, action_source: "web", event_id: request.event.eventId, event_time: request.event.occurredAt / 1000, event_source_url: mapping.sourceUrl, opt_out: false, user_data: { em: [request.event.identifiers.email] } }] };
  return { ok: true, value: { request, configuration: configuration.data, payload } };
}
/** Local checks constrain, never establish, live authority. OM caps event age at 24h; no time rounding. O(k), k<=16. */
function checkAuthority(required: { request: PinterestCapiRequest; configuration: PinterestCapiConfiguration; now: number }): Outcome<void> {
  const { request, configuration, now } = required;
  if (configuration.mode !== "production-server" || !grantMatches(required)) return failure({ code: "forbidden" });
  if (request.grant.revoked || now >= request.grant.expiresAt) return failure({ code: "forbidden" });
  if (!Number.isSafeInteger(now) || now < request.event.occurredAt || now - request.event.occurredAt > 86400000) return failure({ code: "expired" });
  if (request.event.occurredAt % 1000 !== 0) return failure({ code: "not_implemented" });
  return { ok: true, value: undefined };
}
/** Bind every authority dimension, including the open definition and payload schema. O(k), k<=16. */
function grantMatches(required: { request: PinterestCapiRequest; configuration: PinterestCapiConfiguration }): boolean {
  const { request: { context, grant, event }, configuration } = required;
  const scopes = [context.scope, grant.scope].every(scope => scope.ownerId === configuration.scope.ownerId && scope.workspaceId === configuration.scope.workspaceId);
  return scopes && grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId
    && grant.destination === configuration.destination && event.destination === configuration.destination
    && grant.purpose === configuration.purpose && event.purpose === configuration.purpose
    && grant.payloadSchema === configuration.payloadSchema && grant.definitionIds.includes(event.definitionId);
}
/** Token lookup precedes authority; exact private payload survives caller/host mutation. O(b), one POST maximum. */
async function dispatch(required: { dependencies: PinterestCapiDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<PinterestConversionOutcome>> {
  const { dependencies, prepared } = required;
  const io = { ...dependencies, configuration: prepared.configuration };
  const credential = await resolveCredential({ dependencies: io }, optional);
  if (!credential.ok) return credential;
  let executed = false;
  try {
    return await dependencies.authority.dispatch({ ...structuredClone(prepared.request), configuration: structuredClone(prepared.configuration), payload: structuredClone(prepared.payload), execute: async fence => {
      if (executed) return failure({ code: "conflict" });
      executed = true;
      const checked = checkAuthority({ ...prepared, now: dependencies.clock.now({}) });
      if (!checked.ok) return checked;
      if (optional?.signal?.aborted) return failure({ code: "cancelled" });
      if (!fence.isCurrent()) return failure({ code: "forbidden" });
      const request = { method: "POST" as const, url: "https://api.pinterest.com/v5/ad_accounts/" + prepared.configuration.accountId + "/events", body: JSON.stringify(prepared.payload) };
      const response = await requestPinterest({ dependencies: io, context: prepared.request.context, request, credential: credential.value, isCurrent: fence.isCurrent }, optional);
      if (!response.ok) return unknown();
      const ack = z.object({ num_events_received: z.literal(1), num_events_processed: z.literal(1), events: z.array(z.object({ status: z.literal("processed"), error_message: z.literal("").nullable().optional() })).length(1) }).safeParse(response.value.body);
      return { ok: true, value: { status: response.value.status === 200 && ack.success ? "delivered" : "unknown" } };
    } }, optional);
  } catch { return executed ? unknown() : failure({ code: "unavailable" }); }
}
function unknown(): Outcome<PinterestConversionOutcome> { return { ok: true, value: { status: "unknown" } }; }
