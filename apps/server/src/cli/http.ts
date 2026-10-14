import { addonListSchema, addonSummarySchema, addonUninstallReceiptSchema, integrationListSchema, integrationSummarySchema } from '@open-marketing/contracts';
/** Owner HTTP mapping shared by the server and CLI. */
import { z } from "zod";
import {
  assistantSettingsStatusSchema, conversationListSchema, conversationSchema, appErrorSchema, chatMessageSchema, confirmationCardSchema, epochSchema, idSchema, moneySchema, navigationTargetSchema, parseBoundary, runEventSchema,
} from "@open-marketing/contracts";
import type { AppError, Outcome } from "@open-marketing/contracts";

const campaign = z.strictObject({
  id: idSchema, title: z.string().max(200), detail: z.string().max(1024), status: z.string().max(100),
});
const campaignsPage = z.strictObject({ items: z.array(campaign).max(100), cursor: idSchema.nullable() });
const approvalsPage = z.strictObject({ items: z.array(confirmationCardSchema).max(100), cursor: idSchema.nullable() });
const allowance = z.strictObject({ daily: moneySchema, remaining: moneySchema, timezone: z.string().min(1).max(100) });
/** Shell-only snapshot; unwired domain pages are omitted. Studio validates its own presentation boundary. */
const studioSnapshot = z.strictObject({
  workspace: z.string().max(100), mode: z.literal("connected"),
  metrics: z.array(z.strictObject({ label: z.string().max(100), value: z.string().max(100), detail: z.string().max(200) })).max(12),
  rows: z.record(navigationTargetSchema, z.array(campaign).max(100)), messages: z.array(chatMessageSchema).max(200),
  cards: z.array(confirmationCardSchema).max(50), allowance,
});

/** ONE owner route contract. Responses use the shared Outcome envelope, not raw DTOs.
 * App-local read models stay outside the pure shared contracts package.
 */
export const routes = {
  addons: { method: 'GET', path: '/api/addons/v1/packages', schema: addonListSchema },
  addonInstall: { method: 'POST', path: '/api/addons/v1/install', schema: addonSummarySchema },
  addonSetEnabled: { method: 'POST', path: '/api/addons/v1/set-enabled', schema: addonSummarySchema },
  addonUninstall: { method: 'POST', path: '/api/addons/v1/uninstall', schema: addonUninstallReceiptSchema },
  integrations: { method: 'GET', path: '/api/addons/v1/integrations', schema: integrationListSchema },
  integrationConnect: { method: 'POST', path: '/api/addons/v1/integrations/token', schema: integrationSummarySchema },
  integrationDisconnect: { method: 'POST', path: '/api/addons/v1/integrations/disconnect', schema: integrationSummarySchema },
  status: { method: "GET", path: "/api/status", schema: z.strictObject({ ready: z.boolean(), mode: z.enum(["production", "local", "unavailable"]) }) },
  snapshot: { method: "GET", path: "/api/studio/snapshot", schema: studioSnapshot },
  campaigns: { method: "GET", path: "/api/campaigns", schema: campaignsPage },
  campaign: { method: "GET", path: "/api/campaigns/:id", schema: campaign },
  approvals: { method: "GET", path: "/api/safety/approvals", schema: approvalsPage },
  approval: { method: "GET", path: "/api/safety/approvals/:id", schema: confirmationCardSchema },
  answer: { method: "POST", path: "/api/safety/approvals/:id/answer", schema: z.strictObject({ status: z.literal("recorded") }) },
  halt: { method: "POST", path: "/api/safety/halt", schema: z.discriminatedUnion("status", [
    z.strictObject({ accountId: idSchema, status: z.enum(["requested", "pending", "completed"]) }),
    z.strictObject({ accountId: idSchema, status: z.literal("failed"), error: appErrorSchema }),
  ]) },
  allowance: { method: "GET", path: "/api/safety/allowance", schema: allowance },
  ask: { method: "POST", path: "/api/runs", schema: z.strictObject({ runId: idSchema, status: z.enum(["requested", "pending"]), expiresAt: epochSchema.optional(), conversationId: idSchema.optional(), mode: z.enum(['sandbox', 'model']).optional() }) },
  conversations: { method: "GET", path: "/api/conversations", schema: conversationListSchema },
  conversation: { method: "GET", path: "/api/conversations/:id", schema: conversationSchema },
  createConversation: { method: "POST", path: "/api/conversations", schema: conversationSchema.shape.conversation },
  assistantSettings: { method: "GET", path: "/api/assistant/settings", schema: assistantSettingsStatusSchema },
  setAssistantSettings: { method: "POST", path: "/api/assistant/settings", schema: assistantSettingsStatusSchema },
  runEvents: { method: "GET", path: "/api/runs/:id/events", schema: z.strictObject({ runId: idSchema, status: z.enum(['running', 'completed', 'cancelled', 'interrupted']), events: z.array(runEventSchema).max(128) }) },
  cancelRun: { method: "POST", path: "/api/runs/:id/cancel", schema: z.strictObject({ runId: idSchema, status: z.enum(['requested', 'cancelled']) }) },
} as const;

/** Native fetch ABI is intentional; the launcher and fixtures wrap it here. */
export interface HttpRuntime {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ids: { next(required: Record<string, never>): string };
  readonly deadline: { create(required: { timeoutMs: number }): { signal: AbortSignal; dispose(required: Record<string, never>): void } };
}

/** Validated owner session metadata shared by both requests of an approval exchange. */
export interface HttpSession {
  readonly runtime: HttpRuntime;
  readonly baseUrl: string;
  readonly token: string;
  readonly correlationId: string;
  readonly traceId: string;
}

/** Stable CLI failure, without tainted input or opaque exception messages. */
export function failure<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}

const configuration = z.strictObject({
  baseUrl: z.url().max(2048), token: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
  correlationId: idSchema.regex(/^[A-Za-z0-9._:-]+$/), traceId: idSchema.regex(/^[A-Za-z0-9._:-]+$/),
});

/** Validate only owner-client configuration; never read process.env or agent credentials.
 * @returns A session or invalid_input/unauthenticated. IDs are injected, not generated here.
 * @complexity O(configuration bytes), bounded to 11 KiB, with O(configuration bytes) space.
 */
export function createSession(required: { runtime: HttpRuntime }): Outcome<HttpSession> {
  if (!required.runtime.env.OM_OWNER_TOKEN) return failure({ code: "unauthenticated", message: "Set OM_OWNER_TOKEN to an owner session token" });
  const parsed = parseBoundary({ schema: configuration, input: {
    baseUrl: required.runtime.env.OM_SERVER_URL, token: required.runtime.env.OM_OWNER_TOKEN,
    correlationId: required.runtime.ids.next({}), traceId: required.runtime.ids.next({}),
  } });
  if (!parsed.ok) return failure({ code: "invalid_input", message: "Invalid OM_SERVER_URL, OM_OWNER_TOKEN, or request IDs" });
  const url = new URL(parsed.value.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return failure({ code: "invalid_input", message: "OM_SERVER_URL must be an HTTP(S) origin without credentials, query, or path" });
  }
  return { ok: true, value: { runtime: required.runtime, ...parsed.value, baseUrl: url.origin } };
}

/** Escape terminal controls at the output sink without modifying submitted values.
 * @complexity O(text characters) time and space; callers supply bounded data.
 */
export function terminalText(required: { text: string }): string {
  return required.text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

interface HttpRequest<T> {
  readonly session: HttpSession;
  readonly route: { readonly method: "GET" | "POST"; readonly path: string; readonly schema: z.ZodType<T> };
  readonly id?: string;
  readonly query?: { readonly limit: number; readonly cursor?: string; readonly kind?: string } | { readonly after: number };
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/** Read the response incrementally, enforcing the byte cap before accumulating each chunk.
 * The request deadline remains live through body consumption and schema parsing.
 * @complexity O(n) time/space for n response bytes, at most 1 MiB.
 */
async function readResponse(required: { response: Response }): Promise<Outcome<unknown>> {
  const reader = required.response.body?.getReader();
  if (!reader) return failure({ code: "protocol_mismatch", message: "Missing HTTP response body" });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) return failure({ code: "limit_exceeded", message: "HTTP response exceeds 1 MiB" });
      text += decoder.decode(chunk.value, { stream: true });
    }
    return parseJson({ text: text + decoder.decode() });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Convert malformed wire JSON into a protocol failure without exposing its contents. */
function parseJson(required: { text: string }): Outcome<unknown> {
  try { return { ok: true, value: JSON.parse(required.text) as unknown }; }
  catch { return failure({ code: "protocol_mismatch", message: "Malformed HTTP JSON response" }); }
}

/** Validate the shared envelope as well as HTTP status; a non-2xx success is contradictory. */
function validateResponse<T>(required: { input: unknown; schema: z.ZodType<T>; successful: boolean }): Outcome<Outcome<T>> {
  const envelope = z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value: required.schema }),
    z.strictObject({ ok: z.literal(false), error: appErrorSchema }),
  ]);
  const parsed = parseBoundary({ schema: envelope, input: required.input });
  if (!parsed.ok) return failure({ code: "protocol_mismatch", message: "Malformed HTTP response envelope or value" });
  if (!required.successful && parsed.value.ok) return failure({ code: "protocol_mismatch", message: "HTTP status contradicts success response" });
  return { ok: true, value: parsed.value };
}

/** Reject redirects and validate a bounded response before acknowledging any operation. */
async function receiveResponse<T>(required: { response: Response; schema: z.ZodType<T> }): Promise<Outcome<Outcome<T>>> {
  if (required.response.status >= 300 && required.response.status < 400) {
    await required.response.body?.cancel();
    return failure({ code: "protocol_mismatch", message: "HTTP redirects are not permitted" });
  }
  const input = await readResponse({ response: required.response });
  if (!input.ok) return input;
  return validateResponse({ input: input.value, schema: required.schema, successful: required.response.ok });
}

/** POST failures after dispatch are uncertain; callers must reread server state, never auto-retry. */
function transportFailure<T>(required: { method: "GET" | "POST"; code: AppError["code"]; message: string }): Outcome<T> {
  if (required.method === "POST") return failure({ code: required.code, message: required.message + "; outcome unknown. Read server state before another submission" });
  return failure({ ...required, retryable: required.code === "unavailable" });
}

/** Fixed CLI query shapes; preserve cursor omission and encode all values through URLSearchParams. */
function queryString(required: { query: NonNullable<HttpRequest<unknown>["query"]> }): string {
  const query = new URLSearchParams();
  if ('after' in required.query) query.set('after', String(required.query.after));
  else {
    query.set('limit', String(required.query.limit));
    if (required.query.kind !== undefined) query.set('kind', required.query.kind);
    if (required.query.cursor !== undefined) query.set('cursor', required.query.cursor);
  }
  return query.toString();
}

/** Perform exactly one HTTP request with owner auth, tracing, and a 15-second deadline.
 * Redirects are rejected to keep the owner token on the configured origin. No retries.
 * @returns Validated server Outcome, or a typed transport/protocol/size failure.
 * @complexity O(n) time/space, n <= 1 MiB response bytes; one network call.
 */
export async function requestOm<T>(required: HttpRequest<T>): Promise<Outcome<T>> {
  const { session, route } = required;
  const deadline = session.runtime.deadline.create({ timeoutMs: 15000 });
  try {
    const url = new URL(route.path.replace(":id", encodeURIComponent(required.id ?? "")), session.baseUrl);
    if (required.query) url.search = queryString({ query: required.query });
    const headers = {
      authorization: "Bearer " + session.token, accept: "application/json", "content-type": "application/json",
      "x-correlation-id": session.correlationId, "x-trace-id": session.traceId,
      "idempotency-key": session.correlationId,
    };
    const response = await session.runtime.fetch(url, {
      method: route.method, headers, redirect: "error", signal: required.signal ? AbortSignal.any([deadline.signal, required.signal]) : deadline.signal,
      body: required.body === undefined ? undefined : JSON.stringify(required.body),
    });
    const parsed = await receiveResponse({ response, schema: route.schema });
    if (!parsed.ok) return transportFailure({ method: route.method, ...parsed.error });
    return parsed.value;
  } catch {
    return transportFailure({ method: route.method, code: "unavailable", message: "HTTP request failed or response could not be read" });
  } finally {
    deadline.dispose({});
  }
}
