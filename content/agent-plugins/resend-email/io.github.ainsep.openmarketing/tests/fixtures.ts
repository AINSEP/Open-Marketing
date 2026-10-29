import { createMailProviderRegistry, createMailDeliveryPolicy, createPolicyMailer, createMailLaneLimiter, wrapMailerWithPurposeGate, createMailFeedbackIngest } from "@jini-ai/platform/mail";
import type { MailProviderModule, MailSendLedgerPort, MailSuppressionRepoPort, MailFeedbackInboxPort } from "@jini-ai/platform/mail";
import type { ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createResendMailProvider, createResendEmailAdapter } from "../src/index.js";
import type { ResendEmailDependencies, ResendEmailGatewayPort, ResendEmailInvocation } from "../src/index.js";

/** Synthetic fixture values; real host adapters must run the same dispatch suite. */
export const domainId = "d91cd9bd-1176-453e-8fc1-35364d380206";
export const domain = { id: domainId, name: "example.com", status: "verified", open_tracking: false, click_tracking: false, capabilities: { sending: "enabled" }, records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "fixture", status: "verified", ttl: "Auto" }] };
export function invocation(required: { command?: ResendEmailInvocation["command"] } = {}): ResendEmailInvocation {
  return { context: { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" }, operationId: "operation",
    command: required.command ?? { kind: "domain_status", limit: 100 } };
}
export type FixtureOptions = { response?: (required: { signal: AbortSignal }) => Response | Promise<Response>; deadline?: ResendEmailDependencies["deadline"]; credentialHook?: () => void; credential?: unknown; gateway?: ResendEmailGatewayPort };
export function denial(): Outcome<never> { return { ok: false, error: { code: "forbidden", message: "Fixture denied", retryable: false } }; }
/** Synthetic admission/connection fence only; never a production authorization implementation. */
export function fixture(required: FixtureOptions = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const effects: Parameters<ResendEmailGatewayPort["dispatch"]>[0][] = [];
  const state = { admitted: true, connection: true, credentialCalls: 0 };
  const gateway: ResendEmailGatewayPort = required.gateway ?? { async dispatch(input) {
    effects.push(input);
    if (!state.admitted || !state.connection) return denial();
    return input.execute();
  } };
  const dependencies: ResendEmailDependencies = {
    configuration: { scope: invocation().context.scope, connectionId: "connection", pluginDigest: "a".repeat(64), bindingId: "binding" }, gateway,
    credentials: { async access() { state.credentialCalls++; required.credentialHook?.(); return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret" }) as { accessToken: string } }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response({ signal: init!.signal! }) : Response.json({ data: [domain], has_more: false }); },
    deadline: required.deadline ?? (() => new AbortController().signal),
    observer: { observe(event) { observations.push(event); } },
  };
  return { adapter: createResendEmailAdapter(dependencies), dependencies, calls, effects, state, observations };
}
export type Fixture = ReturnType<typeof fixture>;

/** Name the public ABI projection so declaration inference never exposes pnpm storage paths. */
type MailRequests = Parameters<Parameters<MailProviderModule["create"]>[0]["kit"]["httpClient"]["send"]>[0][];

/** Synthetic policy/authority wiring fixture; it does not prove the real server consent barrier. */
export function mailFixture(required: { provider: (required: Pick<Parameters<typeof createResendMailProvider>[0], "authority" | "clock">) => ReturnType<typeof createResendMailProvider>; token: string; transport?: "memory" | "http";
  response?: () => { status: number; bodyText: string; headers?: Record<string, string> }; redirectTo?: string; now?: number; limit?: { perSecond: number; burst: number } }) {
  const requests: MailRequests = [];
  const state = { allowed: true, ready: true, now: required.now ?? 1791849600000 };
  type Entry = { payloadHash: string; outcome: "reserved" | "sent" | "failed" | "unknown"; providerMessageId?: string };
  const rows = new Map<string, Entry>();
  const suppressed = new Set<string>();
  const completed = new Set<string>();
  const keyFor = (input: { workspaceId: string; idempotencyKey: string; recipient: string }) => JSON.stringify([input.workspaceId, input.idempotencyKey, input.recipient]);
  const ledger: MailSendLedgerPort = {
    async reserve(input, options) {
      if (options?.reclaimUnknown) throw new Error("unknown reclaim forbidden");
      const key = keyFor(input);
      const row = rows.get(key);
      if (row && row.outcome !== "failed") return { status: "existing", outcome: row.outcome, payloadHash: row.payloadHash,
        ...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}) };
      rows.set(key, { payloadHash: input.payloadHash, outcome: "reserved" });
      return { status: "reserved" };
    }, async mark(input) {
      const row = rows.get(keyFor(input));
      if (!row) throw new Error("missing reservation");
      rows.set(keyFor(input), { payloadHash: row.payloadHash, outcome: input.outcome,
        ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}) });
    } };
  const suppression: MailSuppressionRepoPort = {
    async isSuppressed(input) { return suppressed.has(JSON.stringify([input.workspaceId, input.normalizedAddress, "all"]))
      || (input.lane === "bulk" && suppressed.has(JSON.stringify([input.workspaceId, input.normalizedAddress, "bulk"]))); },
    async suppress(input) { suppressed.add(JSON.stringify([input.workspaceId, input.normalizedAddress, input.scope])); } };
  const inbox: MailFeedbackInboxPort = {
    async record(input) { return completed.has(input.providerId + ":" + input.event.eventId) ? "duplicate" : "inserted"; },
    async complete(input) { completed.add(input.providerId + ":" + input.eventId); } };
  const provider = required.provider({ clock: { now: () => state.now }, authority: async ({ execute }) => {
    if (!state.allowed) return { ok: false, errorCode: "authority_denied", message: "Synthetic authority denied", retryable: false };
    return execute();
  } });
  const registry = createMailProviderRegistry({}, { builtins: [provider] });
  const inner = registry.get({ id: provider.id })!.provider.create({ credential: { token: required.token }, kit: { httpClient: { async send(input) {
    requests.push(input);
    const reply = required.response?.() ?? { status: 200, bodyText: JSON.stringify({ id: "resend-message", MessageId: "ses-message" }) };
    if (Buffer.byteLength(reply.bodyText) > 1048576) throw new Error("response too large");
    if (required.transport !== "http") return { ...reply, headers: reply.headers ?? {} };
    const response = new Response(reply.bodyText, { status: reply.status, headers: reply.headers });
    const headers: Record<string, string> = {};
    // Native Headers.forEach supplies scalar value/key arguments.
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, bodyText: await response.text(), headers };
  } } } });
  const policy = createMailDeliveryPolicy({ providerId: provider.id, ledger, suppression, supportsAttachments: false },
    { ...(required.redirectTo ? { testMode: { kind: "redirect" as const, to: { email: required.redirectTo } } } : {}),
      resendPolicy: () => "never", nowIso: () => new Date(state.now).toISOString(),
      limiter: createMailLaneLimiter({ limit: required.limit ?? { perSecond: 100, burst: 100 } }, { now: () => state.now }) });
  const mailer = wrapMailerWithPurposeGate({ inner: createPolicyMailer({ inner, policy }), mode: "production", readiness: { isReady: () => state.ready } });
  const ingest = createMailFeedbackIngest({ parserFor: input => input.providerId === provider.id ? provider.feedback : undefined,
    secretsFor: async () => ["whsec_c3ludGhldGlj"], inbox, suppression }, { now: () => state.now });
  return { mailer, inner, requests, state, rows, suppression, ingest, registry, provider };
}
/** Exact RFC8058 values; footer destination is supplied by the server's unsubscribe endpoint. */
export const mailInput = { workspaceId: "workspace", idempotencyKey: "delivery-1", sourceContext: { module: "broadcast", ref: "definition" },
  message: { workspaceId: "workspace", from: { email: "sender@example.com" }, to: { email: "recipient@example.net" }, subject: "Fixture",
    text: "Fixture. Unsubscribe: https://example.com/unsubscribe/fixture", headers: {
      "List-Unsubscribe": "<https://example.com/unsubscribe/fixture>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } };
