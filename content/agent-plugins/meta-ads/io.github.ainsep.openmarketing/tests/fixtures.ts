import { z } from "zod";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import { createHostedMetaGateway, createMetaAdsAdapter } from "../src/adapter.js";
import { digest, failure } from "../src/boundary.js";
import { encodeCommand } from "../src/commands.js";
import type { MetaCommand, MetaInvocation } from "../src/commands.js";
import type { MetaBinding } from "../src/evidence.js";
import type { MetaCall, MetaGatewayPort, MetaSchemaPort } from "../src/ports.js";

/** All evidence in this module is fabricated test evidence, never vendor certification. */
export const pluginDigest = "a".repeat(64);
export const now = 1791849600000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const clock: ClockPort = { now: () => now };
export const observer: ObserverPort = { observe: () => undefined };
export const campaign: MetaCommand = { kind: "create-campaign", name: "fixture", objective: "OUTCOME_TRAFFIC", specialAdCategories: [] };
export const exposure = { amount: { currency: "USD", minorUnits: 10000 }, window: { start: now, end: now + 86400000 } };
export const limit = { amount: { currency: "USD", minorUnits: 10000 }, timezone: "UTC", semantics: "hard_limit" as const, evidenceId: "host-verified-limit" };

export function request(required: { command?: MetaCommand; operationId?: string } = {}): MetaInvocation {
  return { context, operationId: required.operationId ?? "operation", connectionId: "connection", accountId: "123", command: required.command ?? campaign, moneyExposure: exposure, requiredLimit: limit };
}

const tools: Record<MetaCommand["kind"], string> = { "create-campaign": "ads_create_campaign", "create-adset": "ads_create_ad_set", "create-ad": "ads_create_ad", activate: "ads_activate_entity", pause: "ads_update_entity", "set-campaign-cap": "ads_update_entity", "set-daily-budget": "ads_update_entity", "read-entities": "ads_get_ad_entities", report: "ads_insights_advertiser_context" };
// Fabricated permissive vendor schema; the production codec independently closes supported fields.
export const inputSchema = { type: "object", additionalProperties: true, properties: { ad_account_id: { type: "string", pattern: "^[1-9][0-9]*$" } }, required: ["ad_account_id"] };
export const outputSchema = { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] };
export function binding(required: { invocation: MetaInvocation }): MetaBinding {
  const encoded = encodeCommand({ input: required.invocation.command, accountId: required.invocation.accountId });
  if (!encoded.ok) throw new Error("Invalid fixture command");
  return { bindingId: "binding", status: "verified", scope: required.invocation.context.scope, connectionId: required.invocation.connectionId, accountId: required.invocation.accountId, pluginDigest, endpoint: "https://mcp.facebook.com/ads", transport: "streamable-http", toolName: "meta-ads." + tools[required.invocation.command.kind], operation: required.invocation.command.kind, claims: [encoded.value.claim], primarySourceUrl: "https://developers.facebook.com/fixture-only", toolsListDigest: "b".repeat(64), inputSchema, outputSchema, schemaFingerprint: digest({ value: { inputSchema, outputSchema } }), verifiedAt: now - 1000, expiresAt: now + 1000 };
}

/** Schema boundary test double: real Zod output validation; captured input schema is exercised by spy tests. */
export const schemas: MetaSchemaPort = { validate(input) {
  if (digest({ value: input.schema }) === digest({ value: inputSchema })) {
    if (!z.object({ ad_account_id: z.string().regex(/^[1-9][0-9]*$/) }).safeParse(input.value).success) return failure({ code: "protocol_mismatch", message: "Fixture input schema rejected" });
  }
  if (digest({ value: input.schema }) === digest({ value: outputSchema })) {
    if (!z.strictObject({ id: z.string().regex(/^[1-9][0-9]*$/) }).safeParse(input.value).success) return failure({ code: "protocol_mismatch", message: "Fixture output schema rejected" });
  }
  return { ok: true, value: undefined };
} };

export type CallHandler = (required: { call: MetaCall; signal?: AbortSignal }) => Promise<Outcome<unknown>>;
export interface AdapterFixture { adapter: ReturnType<typeof createMetaAdsAdapter>; calls: MetaCall[]; evidence: { value: unknown }; observations: Parameters<ObserverPort["observe"]>[0][]; options: (CallOptions | undefined)[] }

/** Two replaceable gateways run the same suite: direct double and hosted adapter over a local host fixture. */
export function fixture(required: { kind: "double" | "hosted"; invocation?: MetaInvocation; handler?: CallHandler; schemas?: MetaSchemaPort; observer?: ObserverPort }): AdapterFixture {
  const calls: MetaCall[] = [];
  const options: (CallOptions | undefined)[] = [];
  const observations: AdapterFixture["observations"] = [];
  const evidence = { value: binding({ invocation: required.invocation ?? request() }) as unknown };
  const execute = async (input: { context: CallContext; call: MetaCall }, optional?: CallOptions): Promise<Outcome<unknown>> => {
    calls.push(input.call); options.push(optional);
    if (required.handler) return required.handler({ call: input.call, signal: optional?.signal });
    return { ok: true, value: { operationId: input.call.operationId, status: "succeeded", content: [{ type: "json", data: { id: "456" } }] } };
  };
  const double: MetaGatewayPort = { invoke: execute };
  const gateway = required.kind === "hosted" ? createHostedMetaGateway({ host: { invoke: execute }, timeoutMs: 15000 }) : double;
  const observationPort = required.observer ?? { observe: (event: AdapterFixture["observations"][number]) => { observations.push(event); } };
  const adapter = createMetaAdsAdapter({ evidence: { resolve: async () => ({ ok: true, value: evidence.value }) }, gateway, schemas: required.schemas ?? schemas, clock, observer: observationPort, pluginDigest });
  return { adapter, calls, evidence, observations, options };
}

export const hierarchy = { complete: true, entities: [
  { id: "456", account_id: "123", configured_status: "PAUSED", effective_status: "PAUSED", spend_cap: "10000", daily_budget: "1000" },
  { id: "457", account_id: "123", configured_status: "PAUSED", effective_status: "CAMPAIGN_PAUSED" },
  { id: "458", account_id: "123", configured_status: "PAUSED", effective_status: "ADSET_PAUSED" },
] };
