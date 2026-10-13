import { startRunSchema, cancelRunSchema, eventSubscriptionSchema, parseBoundary, notImplemented } from "@open-marketing/contracts";
import type { Outcome, ServiceControlCredential } from "@open-marketing/contracts";
import type { HttpRequest, HttpResponse, JiniRuntimePort } from "../ports.js";
export interface ControlAuthPort { verify(required: { supplied: string | undefined; credential: ServiceControlCredential }): Outcome<void> }
/** Authenticate before reading/parsing tainted body, including loopback requests. Runtime availability remains explicit. */
export async function handleControl(required: { request: HttpRequest; auth: ControlAuthPort; credential: ServiceControlCredential; runtime: JiniRuntimePort; runtimeAvailable?: boolean }): Promise<HttpResponse> {
 const authenticated = required.auth.verify({ supplied: required.request.authorization, credential: required.credential });
 if (!authenticated.ok) return { status: 401, body: authenticated };
 return routeControl(required);
}
/** Closed route dispatch; event subscriptions are bounded and ordered by the runtime port. */
async function routeControl(required: { request: HttpRequest; runtime: JiniRuntimePort; runtimeAvailable?: boolean }): Promise<HttpResponse> {
 const { request, runtime } = required;
 if (request.method === "GET" && request.path === "/internal/v1/health") return healthResponse(required);
 if (request.method === "POST" && request.path === "/internal/v1/runs") {
  const parsed = parseBoundary({ schema: startRunSchema, input: request.body });
  if (!parsed.ok) return { status: 400, body: parsed };
  return runtimeResponse({ outcome: await runtime.startRun(parsed.value) });
 }
 if (request.method === "POST" && /^\/internal\/v1\/runs\/[^/]+\/cancel$/.test(request.path)) return cancelControl(required);
 if (request.method === "GET" && /^\/internal\/v1\/runs\/[^/]+\/events$/.test(request.path)) return eventControl(required);

 return { status: 501, body: notImplemented({ operation: "agent.control.route" }) };
}

/** Health reports configured runtime availability without invoking the runtime. */
function healthResponse(required: { runtimeAvailable?: boolean }): HttpResponse {
 return { status: 200, body: { ok: true, value: { protocolVersion: 1, ready: required.runtimeAvailable === true, runtime: required.runtimeAvailable ? "available" : "unavailable" } } };
}

/** Cancellation validates route/body identity before calling runtime. */
async function cancelControl(required: { request: HttpRequest; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const { request, runtime } = required;

  const parsed = parseBoundary({ schema: cancelRunSchema, input: request.body });
  if (!parsed.ok) return { status: 400, body: parsed };
  if (request.path !== "/internal/v1/runs/" + encodeURIComponent(parsed.value.runId) + "/cancel") return runMismatch();
  return runtimeResponse({ outcome: await runtime.cancelRun(parsed.value) });
}
async function eventControl(required: { request: HttpRequest; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const input = required.request.query;
 const query = typeof input === 'object' && input !== null ? convertQuery({ input }) : input;
 const parsed = parseBoundary({ schema: eventSubscriptionSchema, input: query });
 if (!parsed.ok) return { status: 400, body: parsed };
 if (required.request.path !== "/internal/v1/runs/" + encodeURIComponent(parsed.value.runId) + "/events") return runMismatch();
 return runtimeResponse({ outcome: await required.runtime.events(parsed.value) });
}
/** HTTP query scalars are strings; shared runtime callers may already supply numbers. */
function convertQuery(required: { input: object }): unknown {
 const query = Object.fromEntries(Object.entries(required.input).map(([key, value]) =>
  [key, (key === 'after' || key === 'limit') && typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value]));
 return query;
}
/** Acknowledgements reflect runtime outcomes; unavailable runtimes still return their typed error. */
function runtimeResponse(required: { outcome: Outcome<unknown> }): HttpResponse {
 if (required.outcome.ok) return { status: 200, body: required.outcome };
 const status = required.outcome.error.code === 'not_implemented' ? 501 : 409;
 return { status, body: required.outcome };
}
function runMismatch(): HttpResponse { return { status: 400, body: { ok: false, error: { code: "invalid_input", message: "Run mismatch", retryable: false } } }; }
