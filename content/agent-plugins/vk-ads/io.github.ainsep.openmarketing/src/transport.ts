import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, encodeCommand, vendorIdSchema } from "./commands.js";
import { decodeAccount, decodeCampaignPage } from "./reporting.js";
import type { VkAdsAdapter, VkConfiguration, VkDependencies, VkInvocation, VkResult, VkToken } from "./ports.js";

const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable() });
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const tokenSchema = z.strictObject({ accessToken: secret, expiresAt: epochSchema.optional(), refreshToken: secret.optional() });
const clientSchema = z.strictObject({ clientId: secret, clientSecret: secret, token: tokenSchema.extend({ expiresAt: epochSchema }).nullable() });
const credentialSchema = z.union([tokenSchema, clientSchema]);
type ParsedInvocation = z.infer<typeof invocationSchema>;
type Prepared = { configuration: VkConfiguration; invocation: ParsedInvocation & { command: Exclude<ParsedInvocation["command"], { kind: "report" }> } };
type Runtime = { dependencies: VkDependencies; prepared: Prepared };

/** Inert server adapter: sealed credentials, no token issuance, refresh or automatic retries.
 * @param required - Live admission/binding, broker, guarded fetch, clock, deadline and observer.
 * @returns Read operations with typed, redacted failures; reports remain unavailable.
 * @complexity O(b+n), <=64KiB input, <=1MiB per response, <=100 page rows / 200 report IDs.
 */
export function createVkAdsAdapter(required: VkDependencies): VkAdsAdapter {
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies: required, input }, options);
    if (!prepared.ok) return prepared;
    const runtime = { dependencies: required, prepared: prepared.value };
    let signal = options?.signal;
    let result: Outcome<VkResult>;
    try {
      const deadline = required.deadline({ timeoutMs: 15000 });
      signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const token = await resolveToken(runtime, { signal });
      result = token.ok ? await read(runtime, { signal, token: token.value }) : token;
    } catch { result = failure({ code: transportFailure({ signal }) }); }
    observe({ ...runtime, result });
    return result;
  } };
}

/** Validate bounded inputs and authority before any credential, clock or network access. O(b). */
function prepare(required: { dependencies: VkDependencies; input: VkInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (required.dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const json = JSON.stringify(required.input);
    if (json === undefined || Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    const invocation = invocationSchema.safeParse(JSON.parse(json));
    const configuration = configurationSchema.safeParse(required.dependencies.configuration);
    if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
    return checkBinding({ invocation: invocation.data, configuration: configuration.data });
  } catch { return failure({ code: "invalid_input" }); }
}

/** Statistics response envelope is unverified; reports stay unavailable before any I/O. */
function checkBinding(required: { configuration: VkConfiguration; invocation: ParsedInvocation }): Outcome<Prepared> {
  const { invocation, configuration } = required;
  const { scope } = invocation.context;
  if (scope.ownerId !== configuration.scope.ownerId || scope.workspaceId !== configuration.scope.workspaceId) return failure({ code: "forbidden" });
  if (invocation.command.kind !== "list_accounts" && configuration.accountId === null) return failure({ code: "unavailable" });
  if (invocation.command.kind === "report") return failure({ code: "unavailable" });
  return { ok: true, value: { configuration, invocation: { ...invocation, command: invocation.command } } };
}

/** Read the sealed token on every call, including after reconnection/replacement.
 * No POST is safe without durable issuing/unknown state and reconciliation in the broker.
 * @returns A fresh stored token, expired for pasted tokens, or unavailable for client issuance.
 * @complexity O(b) validation; one broker read, zero token POSTs or saves.
 */
async function resolveToken(required: Runtime, optional: CallOptions): Promise<Outcome<VkToken>> {
  const { dependencies, prepared } = required;
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const binding = { connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId };
  const result = await dependencies.credentials.access(binding, optional);
  if (!result.ok) return failure({ code: result.error.code });
  const parsed = credentialSchema.safeParse(result.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const credential = parsed.data;
  if ("accessToken" in credential) return currentToken({ token: credential, now });
  if (credential.token && currentToken({ token: credential.token, now }).ok) return { ok: true, value: credential.token };
  return failure({ code: "unavailable" });
}

function currentToken(required: { token: VkToken; now: number }): Outcome<VkToken> {
  if (required.token.expiresAt !== undefined && required.now >= required.token.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: required.token };
}

/** Validate token identity on every invocation before account-bound data. O(n), no automatic paging. */
async function read(required: Runtime, optional: CallOptions & { token: VkToken }): Promise<Outcome<VkResult>> {
  const { prepared, dependencies } = required;
  const command = prepared.invocation.command;
  const identity = await request({ ...required, path: "/api/v3/user.json", token: optional.token }, optional);
  if (!identity.ok) return identity;
  const account = decodeAccount({ input: identity.value, accountId: prepared.configuration.accountId });
  if (!account.ok) return account;
  if (command.kind === "list_accounts") return success({ prepared, data: { source: "vk_ads", accountId: account.value.id, retrievedAt: dependencies.clock.now({}), timezone: null, items: [account.value], nextOffset: null } });
  const response = await request({ ...required, ...encodeCommand({ command }), token: optional.token }, optional);
  if (!response.ok) return response;
  const args = { input: response.value, accountId: account.value.id, retrievedAt: dependencies.clock.now({}) };
  const data = decodeCampaignPage({ ...args, limit: command.limit, offset: command.offset });
  if (!data.ok) return data;
  return success({ prepared, data: data.value });
}

/** Fixed official HTTPS origin, no redirects; injected 15s deadline covers broker/identity/page.
 * Each response is streamed to a 1MiB cap; provider errors and secrets never leave this boundary.
 * @complexity O(b) time/space per response, <=1MiB; one fetch per call, zero retries.
 */
async function request(required: Runtime & { path: string; token: VkToken }, optional: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, token } = required;
  const checked = preflight(required, optional);
  if (!checked.ok) return checked;
  const headers = { Authorization: "Bearer " + token.accessToken };
  const response = await dependencies.fetch("https://ads.vk.ru" + required.path, { method: "GET", headers, redirect: "error", signal: optional.signal });
  if (response.status !== 200) {
    await response.body?.cancel();
    return failure({ code: rejection({ status: response.status }) });
  }
  return readBody({ response });
}
function rejection(required: { status: number }): AppError["code"] {
  if (required.status === 401) return "unauthenticated";
  if (required.status === 403) return "forbidden";
  return "unavailable";
}
function transportFailure(required: CallOptions): AppError["code"] {
  return required.signal?.aborted ? "cancelled" : "unavailable";
}

/** Recheck admission/binding/expiry at each actual egress, including after async credential access. */
function preflight(required: Runtime & { token?: VkToken }, optional: CallOptions): Outcome<void> {
  const { dependencies, prepared, token } = required;
  if (dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (!sameBinding({ first: dependencies.configuration, second: prepared.configuration })) return failure({ code: "forbidden" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (token && !currentToken({ token, now }).ok) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
function sameBinding(required: { first: VkConfiguration; second: VkConfiguration }): boolean {
  return required.first.connectionId === required.second.connectionId && required.first.accountId === required.second.accountId && required.first.scope.ownerId === required.second.scope.ownerId && required.first.scope.workspaceId === required.second.scope.workspaceId;
}

/** Cancel an oversized stream immediately; never allocate an unbounded response.text(). O(b). */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  const reader = required.response.body?.getReader();
  if (!reader) return failure({ code: "protocol_mismatch" });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

function success(required: { prepared: Prepared; data: VkResult["data"] }): Outcome<VkResult> {
  if (!epochSchema.safeParse(required.data.retrievedAt).success) return failure({ code: "invalid_input" });
  return { ok: true, value: { operationId: required.prepared.invocation.operationId, status: "succeeded", observedState: "unknown", data: required.data } };
}
function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "VK request " + required.code, retryable: false } };
}
/** Correlation/outcome only; guarded fetch owns durable egress audit. Observer failure cannot retry. */
function observe(required: Runtime & { result: Outcome<VkResult> }): void {
  const { context, command } = required.prepared.invocation;
  try { required.dependencies.observer.observe({ operation: "vk-ads." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot alter a completed read or trigger another dispatch. */ }
}
