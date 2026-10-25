import { z } from "zod";
import { scopeSchema, idSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, encodeCommand, invocationSchema, providerIdSchema, vendorIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import { dateSchema, decodeDownload, downloadLocation, readBytes, reportSchema, supportedReport } from "./reporting.js";
import { failure } from "./ports.js";
import type { AmazonAdsAdapter, AmazonDependencies, AmazonInvocation, AmazonResult } from "./ports.js";

const region = z.enum(["NA", "EU", "FE"]);
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable(), region });
const credentialSchema = z.strictObject({ clientId: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/), accessToken: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), region });
type Credential = z.infer<typeof credentialSchema>;
const origins = { NA: "https://advertising-api.amazon.com", EU: "https://advertising-api-eu.amazon.com", FE: "https://advertising-api-fe.amazon.com" } as const;
const profile = z.object({ profileId: providerIdSchema, countryCode: z.string().regex(/^[A-Z]{2}$/), currencyCode: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128), accountInfo: z.object({ id: z.string().min(1).max(128), type: z.string().min(1).max(64), name: z.string().max(1024), marketplaceStringId: z.string().max(128).optional() }) });
const campaign = z.object({ campaignId: providerIdSchema, name: z.string().max(1024), state: z.enum(["ENABLED", "PAUSED", "ARCHIVED", "PROPOSED", "ENABLING", "USER_DELETED", "OTHER"]), startDate: dateSchema, endDate: dateSchema.nullable().optional() });

/** Inert server-only adapter. Host guards fetch with live admission, account/connection authority,
 * halt, policy and outbox checks. Report downloads make two guarded reads, with no Ads headers on
 * storage. @param required - Injected host dependencies. @returns Typed invoke boundary; no retries.
 * @example createAmazonAdsAdapter({ admitted, configuration, credentials, fetch, createDeadlineSignal, clock, observer })
 * @complexity O(b+n), <=1MiB ordinary response, <=8MiB decoded report and <=10,000 rows.
 */
export function createAmazonAdsAdapter(required: AmazonDependencies): AmazonAdsAdapter {
  return { async invoke(input, options) {
    if (!required.admitted) return failure({ code: "forbidden" });
    const parsed = prepare({ dependencies: required, input });
    if (!parsed.ok) return parsed;
    const invocation = parsed.value;
    const dependencies = { ...required, get admitted() { return required.admitted; }, configuration: structuredClone(required.configuration) };
    const result = await invoke({ dependencies, input: invocation }, options);
    const { correlationId, traceId, runId } = invocation.context;
    try { required.observer.observe({ operation: "amazon-ads." + invocation.command.kind, outcome: result.ok ? result.value.status : result.error.code, correlationId, traceId, runId }); }
    catch { /* Host durable egress audit remains authoritative if telemetry fails. */ }
    return result;
  } };
}

/** Validate and copy tainted envelope before credentials; cap at 64KiB. @complexity O(b). */
function prepare(required: { dependencies: AmazonDependencies; input: unknown }): Outcome<z.output<typeof invocationSchema>> {
  try {
    const bytes = JSON.stringify(required.input);
    if (Buffer.byteLength(bytes) > 65536) return failure({ code: "limit_exceeded" });
    const input = invocationSchema.safeParse(JSON.parse(bytes) as unknown);
    const config = configurationSchema.safeParse(required.dependencies.configuration);
    if (!input.success || !config.success) return failure({ code: "invalid_input" });
    if (input.data.context.scope.ownerId !== config.data.scope.ownerId || input.data.context.scope.workspaceId !== config.data.scope.workspaceId) return failure({ code: "forbidden" });
    if (input.data.command.kind !== "list_accounts" && config.data.accountId === null) return failure({ code: "forbidden" });
    return { ok: true, value: input.data };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Broker and network failures are redacted; unknown report creates never invite retries.
 * @complexity One broker read and at most two bounded requests; zero polling/retries.
 */
async function invoke(required: { dependencies: AmazonDependencies; input: AmazonInvocation }, optional?: CallOptions): Promise<Outcome<AmazonResult>> {
  const { dependencies, input } = required;
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const credential = await resolveCredential({ dependencies }, optional);
    if (!credential.ok) return credential;
    const current = beforeEgress({ dependencies, credential: credential.value }, optional);
    if (!current.ok) return current;
    return exchange({ dependencies, input, credential: credential.value, command: commandSchema.parse(input.command) }, optional);
  } catch { return failure({ code: "unavailable" }); }
}

/** One attempted call; failures after report creation starts remain unknown. @complexity O(b+n). */
async function exchange(required: { dependencies: AmazonDependencies; input: AmazonInvocation; credential: Credential; command: ParsedCommand }, optional?: CallOptions): Promise<Outcome<AmazonResult>> {
  const { dependencies, input, credential, command } = required;
  const wire = encodeCommand({ command });
  const headers: Record<string, string> = { Authorization: "Bearer " + credential.accessToken, "Amazon-Advertising-API-ClientId": credential.clientId, Accept: wire.media, "Content-Type": wire.media };
  if (command.kind !== "list_accounts") headers["Amazon-Advertising-API-Scope"] = dependencies.configuration.accountId!;
  try {
    const response = await dependencies.fetch(origins[dependencies.configuration.region] + wire.path, { method: wire.method, body: wire.body, headers, redirect: "error", signal: signal({ dependencies }, optional) });
    const rejected = await rejection({ response });
    if (rejected) return responseFailure({ input, status: response.status, result: rejected });
    const bytes = await readBytes({ response, max: 1048576 });
    if (!bytes.ok) return uncertainResponse({ input, result: bytes });
    const body: unknown = JSON.parse(bytes.value.toString("utf8"));
    const decoded = await decode({ dependencies, credential, command, body }, optional);
    if (!decoded.ok) return uncertainResponse({ input, result: decoded });
    return { ok: true, value: { operationId: input.operationId, status: command.kind === "request_report" ? "acknowledged" : "succeeded", observedState: "unknown", data: decoded.value } };
  } catch { return uncertainResponse({ input, result: failure({ code: "unavailable" }) }); }
}

/** Parse only the plugin's sealed JSON, honoring broker and pasted expiry. @complexity O(b), <=16KiB. */
async function resolveCredential(required: { dependencies: AmazonDependencies }, optional?: CallOptions): Promise<Outcome<Credential>> {
  const { dependencies } = required;
  const envelope = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId }, optional);
  if (!envelope.ok) return failure({ code: envelope.error.code });
  if (envelope.value.accessToken.length > 16384) return failure({ code: "invalid_input" });
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(envelope.value.accessToken) as unknown);
    if (!parsed.success) return failure({ code: "invalid_input" });
    if (parsed.data.region !== dependencies.configuration.region) return failure({ code: "forbidden" });
    return { ok: true, value: { ...parsed.data, expiresAt: Math.min(parsed.data.expiresAt, envelope.value.expiresAt ?? parsed.data.expiresAt) } };
  } catch { return failure({ code: "invalid_input" }); }
}

function uncertainResponse(required: { input: AmazonInvocation; result: Extract<Outcome<unknown>, { ok: false }> | Outcome<never> }): Outcome<AmazonResult> {
  if (required.input.command.kind === "request_report") return unknown({ input: required.input });
  return required.result;
}
function responseFailure(required: { input: AmazonInvocation; status: number; result: Outcome<never> }): Outcome<AmazonResult> {
  if (required.status >= 500 || required.status === 207) return uncertainResponse(required);
  return required.result;
}

/** Recheck admission, cancellation and epoch-ms expiry immediately before each fetch. @complexity O(1). */
function beforeEgress(required: { dependencies: AmazonDependencies; credential: Credential }, optional?: CallOptions): Outcome<void> {
  if (!required.dependencies.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (!Number.isSafeInteger(required.credential.expiresAt)) return failure({ code: "invalid_input" });
  if (now >= required.credential.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
/** Combine the host deadline and caller cancellation through body consumption. @complexity O(1). */
function signal(required: { dependencies: AmazonDependencies }, optional?: CallOptions): AbortSignal {
  const deadline = required.dependencies.createDeadlineSignal({ timeoutMs: 15000 });
  return optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
}
/** Only documented 200 responses accepted; 207 item-level outcomes fail closed. @complexity O(1). */
async function rejection(required: { response: Response }): Promise<Outcome<never> | null> {
  if (required.response.status === 200) return null;
  await required.response.body?.cancel();
  switch (required.response.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    case 400: return failure({ code: "invalid_input" });
    default: return failure({ code: "unavailable" });
  }
}

/** Atomic bounded projections: no raw provider errors/URLs/extra fields. @complexity O(n), n<=100. */
async function decode(required: { dependencies: AmazonDependencies; credential: Credential; command: ParsedCommand; body: unknown }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { command, body } = required;
  if (command.kind === "list_accounts") return page({ parsed: z.array(profile).max(100).safeParse(body), key: "profileId" });
  if (command.kind === "list_campaigns") {
    const parsed = z.object({ campaigns: z.array(campaign).max(command.maxResults), nextToken: z.string().max(2048).nullable().optional() }).safeParse(body);
    if (!parsed.success) return failure({ code: "protocol_mismatch" });
    return page({ parsed: { success: true, data: parsed.data.campaigns }, key: "campaignId", nextToken: parsed.data.nextToken ?? null });
  }
  return decodeReport(required, optional);
}

/** Scoped report identity and preset checks precede storage egress. @complexity O(b+n), bounded above. */
async function decodeReport(required: { dependencies: AmazonDependencies; credential: Credential; command: ParsedCommand; body: unknown }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { command, body } = required;
  if (command.kind === "list_accounts" || command.kind === "list_campaigns") return failure({ code: "invalid_input" });
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success || !supportedReport({ report: parsed.data })) return failure({ code: "protocol_mismatch" });
  const report = parsed.data;
  if (command.kind !== "request_report" && report.reportId !== command.reportId) return failure({ code: "protocol_mismatch" });
  if (!reportMatches({ command, report })) return failure({ code: "protocol_mismatch" });
  if (command.kind !== "download_report") return { ok: true, value: { reportId: report.reportId, status: report.status, startDate: report.startDate, endDate: report.endDate, preset: report.configuration.reportTypeId } };
  return download({ ...required, report }, optional);
}
function reportMatches(required: { command: ParsedCommand; report: z.output<typeof reportSchema> }): boolean {
  const { command, report } = required;
  if (command.kind !== "request_report") return true;
  return report.startDate === command.startDate && report.endDate === command.endDate && report.configuration.reportTypeId === command.preset;
}
/** Second read uses the host's same guarded fetch with no credentials forwarded. @complexity O(b+n). */
async function download(required: { dependencies: AmazonDependencies; credential: Credential; report: z.output<typeof reportSchema> }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { report } = required;
  const location = downloadLocation({ report, now: required.dependencies.clock.now({}) });
  if (!location.ok) return location;
  const current = beforeEgress(required, optional);
  if (!current.ok) return current;
  const response = await required.dependencies.fetch(location.value, { method: "GET", redirect: "error", credentials: "omit", signal: signal({ dependencies: required.dependencies }, optional) });
  const rejected = await rejection({ response });
  if (rejected) return rejected;
  const bytes = await readBytes({ response, max: 1048576 });
  return bytes.ok ? decodeDownload({ bytes: bytes.value, report }) : bytes;
}
function page(required: { parsed: { success: boolean; data?: Record<string, unknown>[] }; key: string; nextToken?: string | null }): Outcome<unknown> {
  if (!required.parsed.success || !required.parsed.data) return failure({ code: "protocol_mismatch" });
  const keys = required.parsed.data.map(item => item[required.key]);
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items: required.parsed.data, nextToken: required.nextToken ?? null } };
}
function unknown(required: { input: AmazonInvocation }): Outcome<AmazonResult> { return { ok: true, value: { operationId: required.input.operationId, status: "unknown", observedState: "unknown", data: null } }; }
