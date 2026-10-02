import { startRunSchema, cancelRunSchema, eventSubscriptionSchema, parseBoundary, notImplemented } from "@open-marketing/contracts";
import type { Outcome, ServiceControlCredential } from "@open-marketing/contracts";
import type { HttpRequest, HttpResponse, JiniRuntimePort } from "../ports.js";
export interface ControlAuthPort { verify(required: { supplied: string | undefined; credential: ServiceControlCredential }): Outcome<void> }
/** Authenticate before reading/parsing tainted body, including loopback requests. Runtime availability remains explicit. */
export async function handleControl(required: { request: HttpRequest; auth: ControlAuthPort; credential: ServiceControlCredential; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const authenticated = required.auth.verify({ supplied: required.request.authorization, credential: required.credential });
 if (!authenticated.ok) return { status: 401, body: authenticated };
 return routeControl(required);
}
/** Closed route dispatch; event subscriptions are bounded and ordered by the runtime port. */
async function routeControl(required: { request: HttpRequest; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const { request, runtime } = required;
 if (request.method === "GET" && request.path === "/internal/v1/health") return { status: 200, body: { protocolVersion: 1, ready: false, runtime: "unavailable" } };
 if (request.method === "POST" && request.path === "/internal/v1/runs") {
  const parsed = parseBoundary({ schema: startRunSchema, input: request.body });
  if (!parsed.ok) return { status: 400, body: parsed };
  return { status: 501, body: await runtime.startRun(parsed.value) };
 }
 if (request.method === "POST" && /^\/internal\/v1\/runs\/[^/]+\/cancel$/.test(request.path)) return cancelControl(required);
 if (request.method === "GET" && /^\/internal\/v1\/runs\/[^/]+\/events$/.test(request.path)) return eventControl(required);

 return { status: 501, body: notImplemented({ operation: "agent.control.route" }) };
}

/** Cancellation validates route/body identity before calling runtime. */
async function cancelControl(required: { request: HttpRequest; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const { request, runtime } = required;

  const parsed = parseBoundary({ schema: cancelRunSchema, input: request.body });
  if (!parsed.ok) return { status: 400, body: parsed };
  if (request.path !== "/internal/v1/runs/" + encodeURIComponent(parsed.value.runId) + "/cancel") return runMismatch();
  return { status: 501, body: await runtime.cancelRun(parsed.value) };
}
async function eventControl(required: { request: HttpRequest; runtime: JiniRuntimePort }): Promise<HttpResponse> {
 const parsed = parseBoundary({ schema: eventSubscriptionSchema, input: required.request.query });
 if (!parsed.ok) return { status: 400, body: parsed };
 if (required.request.path !== "/internal/v1/runs/" + encodeURIComponent(parsed.value.runId) + "/events") return runMismatch();
 return { status: 501, body: await required.runtime.events(parsed.value) };
}
function runMismatch(): HttpResponse { return { status: 400, body: { ok: false, error: { code: "invalid_input", message: "Run mismatch", retryable: false } } }; }
