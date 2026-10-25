/** Backend-only single conversion. Contacts own hashing; the server owns consent/grants/outbox. */
import { z } from "zod";
import { epochSchema, idSchema, scopeSchema, digestSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, ServiceContext } from "@open-marketing/contracts";
import { vendorId } from "./commands.js";
import { boundedJson, configurationSchema, failure, requestXAds, resolveCredential } from "./transport.js";
import type { XDependencies } from "./transport.js";

const eventSchema = z.strictObject({ eventId: idSchema, definitionId: idSchema, subjectId: idSchema, occurredAt: epochSchema.max(253402300799999), destination: idSchema, purpose: idSchema,
  identifiers: z.strictObject({ email: digestSchema }), identifierDigests: z.strictObject({ email: digestSchema }) });
const grantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema, accountId: idSchema,
  definitionIds: z.array(idSchema).min(1).max(16), destination: idSchema, purpose: idSchema, payloadSchema: idSchema, payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
const capiConfigurationSchema = configurationSchema.extend({ destination: idSchema, purpose: idSchema, payloadSchema: idSchema, mode: z.enum(["production-server", "local-sandbox", "read-only"]),
  conversionRules: z.record(idSchema, z.strictObject({ accountId: vendorId, pixelId: vendorId, eventId: vendorId })).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100) });
const requestSchema = z.strictObject({ context: z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema }), event: eventSchema, grant: grantSchema, deliveryId: idSchema });
/** Existing account-bound pixel/event mappings only; no conversion setup or arbitrary destinations. */
export type XCapiConfiguration = z.infer<typeof capiConfigurationSchema>;
/** Contacts-provided destination email hash and committed internal digest; no raw identifiers. */
export type XConversionInput = z.infer<typeof eventSchema>;
/** Structural open-definition measure grant; current consent remains host-owned. */
export type XMeasurementGrant = z.infer<typeof grantSchema>;
/** Server-job delivery identity from OM's single outbox, never an assistant command. */
export interface XCapiRequest { context: ServiceContext; event: XConversionInput; grant: XMeasurementGrant; deliveryId: string }
/** Accepted count establishes delivery only, never attribution. */
export interface XConversionOutcome { status: "delivered" | "unknown" }
/** Exact one-event JSON bytes bind stable eventId to X's deduplication key. */
export interface XCapiPayload { conversions: { conversion_time: string; event_id: string; conversion_id: string; identifiers: { hashed_email: string }[] }[] }
/** The server claims deliveryId+payload/version in ONE outbox, rejects repeats, verifies contacts
 * digests and account/pixel ownership, checks current grant/consent/mode/admission, appends audit
 * with delivery/correlation/trace IDs, and holds that authority through execute after credentials.
 * execute/isCurrent are the existing host callback ABI; no plugin registry or policy is added.
 */
export type XCapiDependencies = Omit<XDependencies, "gateway" | "configuration"> & { configuration: XCapiConfiguration; authority: {
  dispatch(required: XCapiRequest & { configuration: XCapiConfiguration; payload: XCapiPayload; execute: (fence: { isCurrent: () => boolean }) => Promise<Outcome<XConversionOutcome>> }, optional?: CallOptions): Promise<Outcome<XConversionOutcome>>;
} };
type Input = XCapiRequest & { dependencies: XCapiDependencies };
type Prepared = { request: XCapiRequest; configuration: XCapiConfiguration; payload: XCapiPayload; url: string };

/** Deliver one documented event using contacts' email hash and a stable conversion_id. Uncertain
 * egress reports unknown; neither this function nor reconciliation retries a POST.
 * @example deliverConversion({ context, event, grant, deliveryId, dependencies })
 * @complexity O(b) time/space, input<=64KiB, <=100 mappings; one <=15s/1MiB POST, no retries.
 */
export async function deliverConversion(required: Input, optional: CallOptions = {}): Promise<Outcome<XConversionOutcome>> {
  const prepared = prepare({ input: required }, optional);
  if (!prepared.ok) return prepared;
  const result = await dispatch({ dependencies: required.dependencies, prepared: prepared.value }, optional);
  observe({ input: required, result });
  return result;
}

/** No documented per-event receipt endpoint: validate and report unknown with ZERO I/O.
 * @example reconcileConversion({ context, event, grant, deliveryId, dependencies })
 * @complexity O(b), input<=64KiB, <=100 mappings; no credential access, dispatch or network.
 */
export async function reconcileConversion(required: Input, optional: CallOptions = {}): Promise<Outcome<XConversionOutcome>> {
  const prepared = prepare({ input: required }, optional);
  return prepared.ok ? unknown() : prepared;
}

/** Snapshot strict event/grant/config before await; deny raw/extra identity fields atomically. O(b). */
function prepare(required: { input: Input }, optional: CallOptions): Outcome<Prepared> {
  const { input } = required;
  if (!input.dependencies.configuration.admitted) return failure({ code: "forbidden" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedJson({ input: { request: { context: input.context, event: input.event, grant: input.grant, deliveryId: input.deliveryId }, configuration: input.dependencies.configuration } });
  if (!bounded.ok) return bounded;
  const parsed = z.strictObject({ request: requestSchema, configuration: capiConfigurationSchema }).safeParse(bounded.value);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const { request, configuration } = parsed.data;
  const rule = Object.hasOwn(configuration.conversionRules, request.event.definitionId) ? configuration.conversionRules[request.event.definitionId] : undefined;
  if (!rule || rule.accountId !== configuration.accountId) return failure({ code: "not_implemented" });
  if (!authorityMatches({ request, configuration, now: input.dependencies.clock.now({}) })) return failure({ code: "forbidden" });
  const payload: XCapiPayload = { conversions: [{ conversion_time: new Date(request.event.occurredAt).toISOString(), event_id: rule.eventId, conversion_id: request.event.eventId, identifiers: [{ hashed_email: request.event.identifiers.email }] }] };
  return { ok: true, value: { request, configuration, payload, url: `https://ads-api.x.com/12/measurement/conversions/${rule.pixelId}` } };
}

/** Local checks narrow the host fence; they do not establish current consent. O(k), k<=16 definitions. */
function authorityMatches(required: { request: XCapiRequest; configuration: XCapiConfiguration; now: number }): boolean {
  const { request, configuration, now } = required;
  const { grant, event, context } = request;
  const scopesMatch = context.scope.ownerId === configuration.scope.ownerId && context.scope.workspaceId === configuration.scope.workspaceId
    && grant.scope.ownerId === configuration.scope.ownerId && grant.scope.workspaceId === configuration.scope.workspaceId;
  const destinationMatches = grant.destination === configuration.destination && event.destination === configuration.destination && grant.purpose === configuration.purpose && event.purpose === configuration.purpose;
  const bindingMatches = grant.connectionId === configuration.connectionId && grant.accountId === configuration.accountId && grant.payloadSchema === configuration.payloadSchema && grant.definitionIds.includes(event.definitionId);
  const current = Number.isSafeInteger(now) && now >= event.occurredAt && now < grant.expiresAt && !grant.revoked && configuration.admitted && configuration.mode === "production-server";
  return scopesMatch && destinationMatches && bindingMatches && current;
}

/** Credential resolution precedes authority claim; immutable wire bytes survive callback mutation.
 * Once egress starts, exceptions/malformed acks stay unknown; callback executes at most once. O(b).
 */
async function dispatch(required: { dependencies: XCapiDependencies; prepared: Prepared }, optional: CallOptions): Promise<Outcome<XConversionOutcome>> {
  const { dependencies, prepared } = required;
  let executed = false;
  let attempted = false;
  try {
    const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
    if (!credential.ok) return credential;
    return await dependencies.authority.dispatch({ ...structuredClone({ ...prepared.request, configuration: prepared.configuration, payload: prepared.payload }), execute: async fence => {
      if (executed) return failure({ code: "conflict" });
      executed = true;
      if (optional.signal?.aborted) return failure({ code: "cancelled" });
      if (!authorityMatches({ ...prepared, now: dependencies.clock.now({}) }) || !fence.isCurrent()) return failure({ code: "forbidden" });
      attempted = true;
      const response = await requestXAds({ dependencies, request: { url: prepared.url, method: "POST", body: JSON.stringify(prepared.payload) }, credential: credential.value, isCurrent: fence.isCurrent }, optional);
      if (!response.ok) return response.error.code === "forbidden" ? response : unknown();
      const ack = z.object({ request: z.object({ params: z.object({ account_id: z.literal(prepared.configuration.accountId) }) }), data: z.object({ conversions_processed: z.literal(1) }) }).safeParse(response.value.body);
      return response.value.status === 200 && ack.success ? { ok: true, value: { status: "delivered" } } : unknown();
    } }, optional);
  } catch { return attempted ? unknown() : failure({ code: "unavailable" }); }
}
function unknown(): Outcome<XConversionOutcome> { return { ok: true, value: { status: "unknown" } }; }
/** No identifiers, payload or provider diagnostics in telemetry. O(1); server appends egress audit. */
function observe(required: { input: Input; result: Outcome<XConversionOutcome> }): void {
  const { context, dependencies } = required.input;
  try { dependencies.observer.observe({ operation: "x_ads.capi", outcome: required.result.ok ? required.result.value.status : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId }); }
  catch { /* Telemetry cannot rewrite conversion acceptance. */ }
}
