import { createMailProviderRegistry, createMailDeliveryPolicy, createPolicyMailer, createMailLaneLimiter, wrapMailerWithPurposeGate, createMailFeedbackIngest } from "@jini-ai/platform/mail";
import type { MailProviderModule, MailSendLedgerPort, MailSuppressionRepoPort, MailFeedbackInboxPort } from "@jini-ai/platform/mail";
import type { ObserverEvent } from "@open-marketing/contracts";
import { createAmazonSesMailProvider, createAmazonSesAdapter } from "../src/index.js";
import type { SesConfiguration, SesDependencies, SesInvocation } from "../src/index.js";

export const now = 1791849600000;
export const context: SesInvocation["context"] = { scope: { ownerId: "owner", workspaceId: "workspace" },
  principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: SesConfiguration = { scope: context.scope, connectionId: "ses-connection", region: "us-east-1",
  domainIdentity: "example.com", pluginDigest: "a".repeat(64), bindingId: "binding" };
export const invocation: SesInvocation = { context, operationId: "operation", command: { kind: "account_status" } };
export const credential = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
export const account = { SendingEnabled: true, ProductionAccessEnabled: false,
  SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 12 }, PricingAttributes: { CurrentPlan: "ESSENTIALS" } };
/** Synthetic AWS-documented unlimited daily quota sentinel. */
export const unlimitedAccount = { ...account, SendQuota: { ...account.SendQuota, Max24HourSend: -1 } };
export const identity = { IdentityType: "DOMAIN", VerifiedForSendingStatus: true, VerificationStatus: "SUCCESS",
  DkimAttributes: { SigningEnabled: true, Status: "SUCCESS", Tokens: ["synthetictoken"] } };
/** Per-test synthetic ports. Integrator supplies the same harness over real host adapters. */
export function fixture(required: { response?: () => Response | Promise<Response> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const dispatches: Parameters<SesDependencies["gateway"]["dispatch"]>[0][] = [];
  const state = { admitted: true, credentialsAllowed: true, credentialCalls: 0, time: now };
  const denied = { ok: false as const, error: { code: "forbidden" as const, message: "Denied", retryable: false } };
  const dependencies: SesDependencies = { configuration, clock: { now: () => state.time },
    observer: { observe: event => { observations.push(event); } },
    credentials: { async access() { state.credentialCalls++; if (!state.credentialsAllowed) return denied; return { ok: true, value: credential }; } },
    gateway: { async dispatch(input) { dispatches.push(input); if (!state.admitted) return denied; return input.execute(); } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} });
      if (required.response) return required.response(); return Response.json(account); },
  };
  return { dependencies, adapter: createAmazonSesAdapter(dependencies), calls, observations, dispatches, state,
    denyAdmission() { state.admitted = false; }, denyCredentials() { state.credentialsAllowed = false; } };
}

/** Name the public ABI projection so declaration inference never exposes pnpm storage paths. */
type MailRequests = Parameters<Parameters<MailProviderModule["create"]>[0]["kit"]["httpClient"]["send"]>[0][];

/** Synthetic policy/authority wiring fixture; it does not prove the real server consent barrier. */
export function mailFixture(required: { provider: (required: Pick<Parameters<typeof createAmazonSesMailProvider>[0], "authority" | "clock">) => ReturnType<typeof createAmazonSesMailProvider>; token: string; transport?: "memory" | "http";
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
  const feedbackIngest = createMailFeedbackIngest({ parserFor: input => input.providerId === provider.id ? provider.feedback : undefined,
    secretsFor: async () => ["whsec_c3ludGhldGlj"], inbox, suppression }, { now: () => state.now });
  const ingest = { async handle(input: Parameters<typeof feedbackIngest.handle>[0]) {
    const prepared = await provider.prepareFeedback({ rawBody: input.rawBody });
    if (!prepared.ok) return { status: prepared.error.retryable ? 503 : 401 };
    return feedbackIngest.handle(input);
  } };
  return { mailer, inner, requests, state, rows, suppression, ingest, registry, provider };
}
/** Exact RFC8058 values; footer destination is supplied by the server's unsubscribe endpoint. */
export const mailInput = { workspaceId: "workspace", idempotencyKey: "delivery-1", sourceContext: { module: "broadcast", ref: "definition" },
  message: { workspaceId: "workspace", from: { email: "sender@example.com" }, to: { email: "recipient@example.net" }, subject: "Fixture",
    text: "Fixture. Unsubscribe: https://example.com/unsubscribe/fixture", headers: {
      "List-Unsubscribe": "<https://example.com/unsubscribe/fixture>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } };

/** Synthetic self-signed certificate/key for signature fixtures; never a trusted production certificate. */
export const snsCertificate = "-----BEGIN CERTIFICATE-----\nMIICvDCCAaQCCQCUU6QCLxFMCDANBgkqhkiG9w0BAQsFADAgMR4wHAYDVQQDDBVz\neW50aGV0aWMtc25zLWZpeHR1cmUwHhcNMjYxMDI2MDY0ODMxWhcNMzYxMDIzMDY0\nODMxWjAgMR4wHAYDVQQDDBVzeW50aGV0aWMtc25zLWZpeHR1cmUwggEiMA0GCSqG\nSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDoh0vnheNJeLftNZ2eJpmGOwTSHg+NuZV3\nP21zXsb7zVL5in/8FjP7KuvRATLRdu+DHiyuNsJh1pU63wZdmDdZjv778z6sTSke\nmQLvsmzaUqf7b0rbO4HD5gnPqP2+LKpaORv1jsXfsUEve6s++GNmzlSbkHKkYv2p\nfnal4Yoj57OMP7ftlhQVUJXxaAs6htwBbHcEXpBUxQlPUAW0EStlW5JZ6QJfMEMW\nrWdFYTC2aOuyDG23FaNaa6e2vPjQhwm0de5EQ8eZWnsbARhe86QBBN9qcXJEmv/P\nk7Sv0xPd5PjvP/YQ++YRZSeZAdyZcSqfcvC+RJSrW0MEwibBYcoLAgMBAAEwDQYJ\nKoZIhvcNAQELBQADggEBAJKaIZrSIy7PJvsCyYdN7HOlUiWgLk3ly6gK1sKA7QBx\n2cVL3+AkTJX7CnhJYp93aVxpifVqRh2wQQEUpGskQ8RQeuPBT8mdE0A9J1a6lZPx\n0wesSWvgGvGA9ItRe7ej1lr1q3n8TI3tLjpogDIwI0/jYimNJKyzve7t/bbGcyh2\nqhOjeiSAMwcp3nH2OoM2yOPOhCGoFYSkGRoHYGriQoTD3jzhW4EaMDzz0YhTBohj\njw2Guqk6mceaZO1nuS54V4bxeBHyDP8yq38IKkrahoPhgG4rB0nykEYN7AhuKE7C\n5Q5PcREME5KrkbFYmiG+iJkxbR2m4cKeAiGeMadW0bA=\n-----END CERTIFICATE-----\n";
export const snsPrivateKey = "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDoh0vnheNJeLft\nNZ2eJpmGOwTSHg+NuZV3P21zXsb7zVL5in/8FjP7KuvRATLRdu+DHiyuNsJh1pU6\n3wZdmDdZjv778z6sTSkemQLvsmzaUqf7b0rbO4HD5gnPqP2+LKpaORv1jsXfsUEv\ne6s++GNmzlSbkHKkYv2pfnal4Yoj57OMP7ftlhQVUJXxaAs6htwBbHcEXpBUxQlP\nUAW0EStlW5JZ6QJfMEMWrWdFYTC2aOuyDG23FaNaa6e2vPjQhwm0de5EQ8eZWnsb\nARhe86QBBN9qcXJEmv/Pk7Sv0xPd5PjvP/YQ++YRZSeZAdyZcSqfcvC+RJSrW0ME\nwibBYcoLAgMBAAECggEBAMURvYPX1hxzojX45b+eaSj5JgnKDlaH/aPV7rYDklLf\n3j29YuDMFHv/EWLOSDp8OVt/nFB9+lofGdSOJf/2vJo7deEkc25l6r6S4YkyR8z0\nloei9+c71Kupb5E+YObnRe03T3na6dq+iEds4WJ58wyzO8OoNXEasG8Qzg+iSYhI\n/jDPWhUiIGp2pH6TOqkFpF+cvXqdKgqU86cNL6gL9xwKV1a5kbJZ8mMiqVwX1ZSh\niYI/izGQLRj1woJ+1DvyWoj2Itt1WIDSiGZhaSoqlURob+20/AbgCVzUKWSPwawF\nBU/PhRmgjlDFnZNRVNHR37bfuXkwMjHZMBXdGaQlKTkCgYEA9gUykabbH3pmGcI1\n+wZiKaeiZ5bDXC89trELEdOdNsHxuEg1W9uowG2DSAM45YiBtFfqU+hokxydz1Ud\nmqGi2aECuQsZK1ngrtTDrhSJd49WIjRy5aIYBlFfznlvCGMY36CnI3G1WwnnnBKv\nK4GQh5H5Ddk7Ibqc8U2dlfkLSPcCgYEA8fX+PDMDCKR9GVHE7egaG569cxLxhf7A\ntXWJDqPxTWm+OlHIHNZkb9GTjmbotEggyq5bzKM9HIPBlBL8cbLqJlEy6aCvQQ6q\ndY0RYxo/Lt5UCUX0skqUfONeaE3PA9fxW1ic+dSi0isWG3hRCoWVU8v2D77jr3Kc\nUr4z+dJNto0CgYEAyjF/XCGMGZTY8PaissqORrnVSdmoec0BpXJgLKiEnwpKhTAj\nWnlveacHrFmpm0vTfcp7dbaeq7lrIYlMqVeKpd4khLxQVUaq2EVZBWsvh6mwGrCM\ndZoAsMCUQveef4AiYzh/5SuA529+gNECUnlLtYAM9orAhHoAnnkxuJ5T3gUCgYEA\nln/oDxG7xVhq56DQ2RoRgzSNqlISIMKAo13kTlLy+K/ZPvU3f5hrCJJXMbAY9moW\n23rwZqzyihX6Blx44U/kDMlc3ayw1cqFhHCma/obas+nfc0hkvSIv9W9FyuupDlh\nSuwnV85HKGrcaWHBJsZIR8MJ3mlhvfOQAHeGZNHGvNECgYBEljqwniT+hHb4xEr0\nI+8K/PK3s5o0ZDY9G29WE09afGHVaz/4Og/VW4iVWKXyvpzTGLSFc066mFPiYGOS\nnlXP91jb04XCzUYUzrp4kQt39HUZFqLClUOgiMrUuTmKfnr3G7rIwLH6842ez4fh\nco9+ikTIeNGhvw6humjXS/1O7w==\n-----END PRIVATE KEY-----\n";
