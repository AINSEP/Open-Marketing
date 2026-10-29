import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, dailyLimitRequirementSchema, digestSchema, effectEnvelopeSchema, idSchema, moneyExposureSchema, parseBoundary, pluginConfigurationSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, DailyLimitRequirement, EffectEnvelope, HaltStopRequest, MoneyExposure, ObserverPort, Outcome, PluginToolsFactory } from "@open-marketing/contracts";
import { boundTikTokJson, decodeTikTokAcknowledgement, decodeTikTokRead, digestTikTokArguments, encodeTikTokCommand, failure, isTikTokRead, parseTool, tiktokCommandSchema, tiktokHaltCommandSchema, tiktokStatus, tiktokSchemaFingerprints, tools, vendorIdSchema } from "./commands.js";
import type { TikTokCommand, TikTokDispatchCommand, TikTokEncoded, TikTokReadCommand } from "./commands.js";
import { createTikTokCredentials, createTikTokFetchEgress } from "./transport.js";
import { uncertainFailure } from "./events.js";
import type { TikTokCall, TikTokGatewayPort } from "./ports.js";

const bindingSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema, pluginDigest: digestSchema });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: tiktokCommandSchema, moneyExposure: moneyExposureSchema.nullable(), requiredLimit: dailyLimitRequirementSchema.nullable() });
/** Backend fingerprint describes the closed campaign-stop mapping, never an agent tool. */
export const tiktokStopSchemaFingerprint = createHash("sha256").update(JSON.stringify(z.toJSONSchema(tiktokHaltCommandSchema))).digest("hex");
export type TikTokBinding = z.infer<typeof bindingSchema>;
export interface TikTokInvocation { readonly context: CallContext; readonly operationId: string; readonly command: TikTokCommand; readonly moneyExposure: MoneyExposure | null; readonly requiredLimit: DailyLimitRequirement | null }
/** Operational ENABLE/DISABLE readback, not a promise of effective serving or attributed spend. */
export interface TikTokResult { readonly operationId: string; readonly status: "succeeded" | "unknown"; readonly observedState: "disabled" | "enabled" | "unknown"; readonly observedAt: number | null; readonly entityIds: readonly string[]; readonly data: unknown }
export interface TikTokAdsAdapter {
  invoke(required: TikTokInvocation, optional?: CallOptions): Promise<Outcome<TikTokResult>>;
}
type Dependencies = { binding: TikTokBinding; gateway: TikTokGatewayPort; clock: ClockPort; observer: ObserverPort };
type Prepared = { context: CallContext; call: TikTokCall; effect: EffectEnvelope };

/** Inert codec around the ONE server dispatcher. It cannot admit itself or authorize spend.
 * @param required - Account/scope binding, server gateway, injected clock and observer.
 * @returns Bound invoke. Each write sends once plus one readback; exceptions stay unknown.
 * @example createTikTokAdsAdapter({ binding, gateway, clock, observer })
 * @complexity O(b log k) bounded validation/digests; <=100 IDs, <=1MiB response; no retries.
 */
export function createTikTokAdsAdapter(required: Dependencies): TikTokAdsAdapter {
  const dependencies = { ...required, binding: structuredClone(required.binding) };
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    return dispatch({ dependencies, prepared: prepared.value }, options);
  } };
}

/** Canonical tools reuse the adapter and strict egress, picking only transport fields.
 * Binding failures precede all I/O; host guarded fetch owns authority. O(b), no retries.
 * @example createTools(dependencies).invoke(invocation)
 */
export const createTools: PluginToolsFactory = dependencies => ({ async invoke(input, options) {
  const command = parseTool({ name: input.name, input: input.input });
  if (!command.ok) return command;
  const configuration = pluginConfigurationSchema.safeParse(dependencies.configuration);
  const context = callContextSchema.safeParse(input.context);
  if (!configuration.success || !context.success) return failure({ code: "invalid_input", message: "Invalid TikTok tool binding" });
  const { scope, connectionId, accountId, pluginDigest } = configuration.data;
  if (!isDeepStrictEqual({ ...input.connection, scope: context.data.scope }, { connectionId, accountId, scope })) return failure({ code: "forbidden", message: "TikTok tool binding mismatch" });
  const egress = createTikTokFetchEgress({ fetch: dependencies.fetch, credentials: createTikTokCredentials(dependencies), observer: dependencies.observer });
  const adapter = createTikTokAdsAdapter({ binding: { scope, connectionId, accountId, pluginDigest }, clock: dependencies.clock, observer: dependencies.observer,
    gateway: { invoke: ({ context, call }, optional) => egress.send({ context, connectionId: call.connectionId, accountId: call.accountId, operationId: call.operationId, request: call.request, isCurrent: () => !optional?.signal?.aborted }, optional) },
  });
  const parsed = parseBoundary({ schema: tiktokCommandSchema, input: command.value });
  if (!parsed.ok) return parsed;
  return adapter.invoke({ context: context.data, operationId: input.operationId, command: parsed.value, moneyExposure: input.moneyExposure, requiredLimit: input.requiredLimit }, options);
} });

/** Validate before gateway I/O; money fields are forwarded only for activation. O(b), pure. */
function prepare(required: { dependencies: Dependencies; input: TikTokInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok call cancelled before dispatch" });
  const bounded = boundTikTokJson({ input: required.input });
  if (!bounded.ok) return bounded;
  const request = parseBoundary({ schema: invocationSchema, input: bounded.value });
  if (!request.ok) return request;
  const binding = validateBinding({ dependencies: required.dependencies, context: request.value.context });
  if (!binding.ok) return binding;
  const command = request.value.command;
  const encoded = encodeTikTokCommand({ input: command, accountId: binding.value.accountId });
  if (!encoded.ok) return encoded;
  return prepareCall({ request: request.value, binding: binding.value, encoded: encoded.value });
}

/** Derive exact effect/digest from local command metadata; server owns the approval decision. O(b log k). */
function prepareCall(required: { request: z.infer<typeof invocationSchema>; binding: TikTokBinding; encoded: TikTokEncoded }): Outcome<Prepared> {
  const { request, binding, encoded } = required;
  const command = request.command;
  const exposure = request.moneyExposure;
  const limit = request.requiredLimit;
  if (command.kind === "activate-entity" && (!exposure || !limit)) return failure({ code: "invalid_input", message: "TikTok activation requires the existing exposure/limit fields for its exact card" });
  const argumentsDigest = digestTikTokArguments({ arguments: encoded.method === "GET" ? encoded.parameters : encoded.body });
  const tool = tools.find(tool => (tool.inputSchema.properties as { kind?: { const?: string } } | undefined)?.kind?.const === command.kind);
  if (!tool) return failure({ code: "protocol_mismatch", message: "TikTok command has no descriptor" });
  const call: TikTokCall = { connectionId: binding.connectionId, accountId: binding.accountId, pluginDigest: binding.pluginDigest, operationId: request.operationId, request: command, argumentsDigest, schemaFingerprint: tiktokSchemaFingerprints[command.kind] };
  const effect = parseBoundary({ schema: effectEnvelopeSchema, input: { operationId: call.operationId, connectionId: call.connectionId, accountId: call.accountId, argumentsDigest, effects: tool.effects, moneyExposure: command.kind === "activate-entity" ? exposure : null, requiredLimit: command.kind === "activate-entity" ? limit : null } });
  if (!effect.ok) return effect;
  return { ok: true, value: { context: request.context, call, effect: effect.value } };
}

/** Static account binding adds constraints; the gateway still verifies live account authority. O(1). */
function validateBinding(required: { dependencies: Dependencies; context: CallContext }): Outcome<TikTokBinding> {
  const parsed = parseBoundary({ schema: bindingSchema, input: required.dependencies.binding });
  if (!parsed.ok) return parsed;
  if (parsed.value.scope.ownerId !== required.context.scope.ownerId || parsed.value.scope.workspaceId !== required.context.scope.workspaceId) return failure({ code: "forbidden", message: "TikTok binding scope mismatch" });
  return parsed;
}

/** Shared backend stop binding/argument check; adds no authority or expiry.
 * Returns a closed DISABLE command or typed mismatch. O(n), <=100 numeric unique IDs.
 * @example checkTikTokHalt({ binding, request })
 */
export function checkTikTokHalt(required: { binding: TikTokBinding; request: HaltStopRequest }): Outcome<z.infer<typeof tiktokHaltCommandSchema>> {
  if (!stopMatches(required)) return failure({ code: "forbidden", message: "TikTok halt binding mismatch" });
  const command = parseBoundary({ schema: tiktokHaltCommandSchema, input: { kind: "halt-stop", campaignIds: required.request.entityIds } });
  if (!command.ok) return command;
  const { adAccountId, entityIds, action, argumentsDigest } = required.request;
  if (digestTikTokArguments({ arguments: { adAccountId, entityIds, action } }) !== argumentsDigest) return failure({ code: "conflict", message: "TikTok halt arguments changed" });
  return command;
}
/** Scope/account/plugin/binding pins all agree before halt dispatch. O(1). */
function stopMatches(required: { binding: TikTokBinding; request: HaltStopRequest }): boolean {
  const { binding, request } = required;
  return request.scope.ownerId === binding.scope.ownerId && request.scope.workspaceId === binding.scope.workspaceId && request.connectionId === binding.connectionId && request.adAccountId === binding.accountId && request.pluginDigest === binding.pluginDigest && request.bindingId === "tiktok-ads.stop.v1";
}

/** Each write has at most one POST and one policy-admitted GET; no hierarchy preflight/auto-repair. */
async function dispatch(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<TikTokResult>> {
  const { prepared, dependencies } = required;
  let result: Outcome<TikTokResult>;
  try {
    const response = await dependencies.gateway.invoke(prepared, optional);
    result = await decodeResult({ dependencies, prepared, response }, optional);
  } catch { result = uncertain({ prepared }); }
  const context = prepared.context;
  try { dependencies.observer.observe({ operation: "tiktok-ads." + prepared.call.request.kind, outcome: result.ok ? result.value.status : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Host durable audit owns the authoritative receipt. */ }
  return result;
}

/** Valid acceptance is distinct from observed operational state. O(b+n), bounded result. */
async function decodeResult(required: { dependencies: Dependencies; prepared: Prepared; response: Outcome<unknown> }, optional?: CallOptions): Promise<Outcome<TikTokResult>> {
  const { prepared, response } = required;
  if (!response.ok) {
    const failed = uncertainFailure({ response });
    return failed.ok ? uncertain({ prepared }) : failed;
  }
  const selection = { command: prepared.call.request };
  if (isTikTokRead(selection)) {
    const read = decodeTikTokRead({ input: response.value, command: selection.command, accountId: prepared.call.accountId });
    return read.ok ? { ok: true, value: resultValue({ prepared, data: read.value }) } : read;
  }
  const ack = decodeTikTokAcknowledgement({ input: response.value });
  if (!ack.ok) return uncertain({ prepared });
  const ids = acknowledgementIds({ command: prepared.call.request, data: ack.value.data });
  if (!ids.ok) return uncertain({ prepared });
  return readback({ ...required, entityIds: ids.value }, optional);
}

/** Creation requires a single matching ID; status calls retain their exact original target(s). O(1). */
function acknowledgementIds(required: { command: TikTokDispatchCommand; data: unknown }): Outcome<string[]> {
  const { command, data } = required;
  switch (command.kind) {
    case "create-campaign-paused": { const parsed = parseBoundary({ schema: z.object({ campaign_id: vendorIdSchema }), input: data }); return parsed.ok ? { ok: true, value: [parsed.value.campaign_id] } : parsed; }
    case "create-adgroup-paused": { const parsed = parseBoundary({ schema: z.object({ adgroup_id: vendorIdSchema }), input: data }); return parsed.ok ? { ok: true, value: [parsed.value.adgroup_id] } : parsed; }
    case "create-ad-paused": { const parsed = parseBoundary({ schema: z.object({ ad_ids: z.array(vendorIdSchema).length(1) }), input: data }); return parsed.ok ? { ok: true, value: parsed.value.ad_ids } : parsed; }
    case "activate-entity": case "pause-entity": return { ok: true, value: [command.entityId] };
    case "halt-stop": return { ok: true, value: command.campaignIds };
    default: return failure({ code: "invalid_input", message: "TikTok write command required" });
  }
}

/** Exact ID/account/page validation prevents incomplete/foreign rows proving DISABLE. O(n), n<=100. */
async function readback(required: { dependencies: Dependencies; prepared: Prepared; entityIds: string[] }, optional?: CallOptions): Promise<Outcome<TikTokResult>> {
  const { dependencies, prepared, entityIds } = required;
  const command = readbackCommand({ command: prepared.call.request, entityIds });
  const encoded = encodeTikTokCommand({ input: command, accountId: prepared.call.accountId });
  if (!encoded.ok || encoded.value.method !== "GET") return uncertain({ prepared });
  const call: TikTokCall = { connectionId: prepared.call.connectionId, accountId: prepared.call.accountId, pluginDigest: prepared.call.pluginDigest, operationId: prepared.call.operationId.slice(0, 247) + ":readback", request: command, argumentsDigest: digestTikTokArguments({ arguments: encoded.value.parameters }), schemaFingerprint: tiktokSchemaFingerprints[command.kind] };
  const effect: EffectEnvelope = { operationId: call.operationId, connectionId: call.connectionId, accountId: call.accountId, argumentsDigest: call.argumentsDigest, effects: ["read"], moneyExposure: null, requiredLimit: null };
  let response: Outcome<unknown>;
  try { response = await dependencies.gateway.invoke({ context: prepared.context, call, effect }, optional); }
  catch { return unconfirmed({ entityIds }); }
  if (!response.ok) return unconfirmed({ entityIds });
  const read = decodeTikTokRead({ input: response.value, command, accountId: call.accountId });
  if (!read.ok) return unconfirmed({ entityIds });
  const rows = (read.value as { data: { list: Record<string, string>[] } }).data.list;
  const status = prepared.call.request.kind === "activate-entity" ? tiktokStatus.enabled : tiktokStatus.disabled;
  if (rows.length !== entityIds.length || rows.some(row => row.operation_status !== status || !parentMatches({ command: prepared.call.request, row }))) return unconfirmed({ entityIds });
  return { ok: true, value: { ...resultValue({ prepared, data: read.value }), observedAt: dependencies.clock.now({}), entityIds, observedState: status === tiktokStatus.disabled ? "disabled" : "enabled" } };
}
/** Map only the changed entity to a GET; no parent hierarchy requests. O(1). */
function readbackCommand(required: { command: TikTokDispatchCommand; entityIds: string[] }): TikTokReadCommand {
  const { command, entityIds } = required;
  const type = command.kind === "activate-entity" || command.kind === "pause-entity" ? command.entityType : command.kind === "create-adgroup-paused" ? "adgroup" : command.kind === "create-ad-paused" ? "ad" : "campaign";
  if (type === "adgroup") return { kind: "get-adgroups", adgroupIds: entityIds, page: 1, pageSize: 100 };
  if (type === "ad") return { kind: "get-ads", adIds: entityIds, page: 1, pageSize: 100 };
  return { kind: "get-campaigns", campaignIds: entityIds, page: 1, pageSize: 100 };
}
function parentMatches(required: { command: TikTokDispatchCommand; row: Record<string, string> }): boolean {
  if (required.command.kind === "create-adgroup-paused") return required.row.campaign_id === required.command.campaignId;
  if (required.command.kind === "create-ad-paused") return required.row.adgroup_id === required.command.adgroupId;
  return true;
}
/** Failed readback never repairs the entity or conceals the known target. O(1). */
function unconfirmed(required: { entityIds: string[] }): Outcome<never> { return failure({ code: "conflict", message: `TikTok write accepted but requested status is unconfirmed for ${required.entityIds[0]}; inspect and explicitly pause if needed` }); }
function resultValue(required: { prepared: Prepared; data: unknown }): TikTokResult { return { operationId: required.prepared.call.operationId, status: "succeeded", observedState: "unknown", observedAt: null, entityIds: [], data: required.data }; }
/** Read errors remain errors; a non-idempotent write may already have happened. O(1). */
function uncertain(required: { prepared: Prepared }): Outcome<TikTokResult> {
  if (isTikTokRead({ command: required.prepared.call.request })) return failure({ code: "unavailable", message: "TikTok read unavailable" });
  return { ok: true, value: { ...resultValue({ ...required, data: null }), status: "unknown" } };
}
