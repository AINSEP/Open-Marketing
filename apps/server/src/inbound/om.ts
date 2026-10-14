import { mcpRequestSchema, parseBoundary, notImplemented, runEventSchema } from "@open-marketing/contracts";
import type { Outcome, RunGrantMetadata, ClockPort, RunEvent, AssistantContext } from "@open-marketing/contracts";
import type { HttpRequest, HttpResponse } from "../ports.js";
export interface RunGrantVerifierPort { verify(required: { authorization: string | undefined }): Promise<Outcome<RunGrantMetadata>> }
/** Fixed local sandbox callbacks. Grant verification and exact route binding precede these effects. */
export interface SandboxCallbacks {
 context(required: { grant: RunGrantMetadata }): Promise<Outcome<AssistantContext | { mode: 'local-sandbox' }>>;
 record(required: { grant: RunGrantMetadata; event: RunEvent }): Promise<Outcome<{ recorded: true }>>;
}
/** Scope comes only from server-verified run grants. No body can widen authority or answer cards. */
export async function handleOmRequest(required: { request: HttpRequest; grants: RunGrantVerifierPort; clock: ClockPort; callbacks?: SandboxCallbacks }): Promise<HttpResponse> {
 const grant = await required.grants.verify({ authorization: required.request.authorization });
 if (!grant.ok) return { status: 401, body: grant };
 const metadata = grant.value;
 if (metadata.revoked || metadata.expiresAt <= required.clock.now({})) return { status: 403, body: { ok: false, error: { code: "expired", message: "Run authority unavailable", retryable: false } } };
 if (required.callbacks) return sandboxRequest({ ...required, callbacks: required.callbacks, grant: metadata });
 if (required.request.path !== "/api/agent/v1/mcp") return { status: 403, body: { ok: false, error: { code: "forbidden", message: "OM route unavailable", retryable: false } } };
 const parsed = parseBoundary({ schema: mcpRequestSchema, input: required.request.body });
 if (!parsed.ok) return { status: 400, body: parsed };
 return { status: 501, body: notImplemented({ operation: "server.om.mcp" }) };
}

/** Run identity comes from the credential; no client body/query may widen it. All other
 * operations (including MCP/tools/model/conversions/owner approvals) deny in this sandbox.
 */
async function sandboxRequest(required: { request: HttpRequest; callbacks: SandboxCallbacks; grant: RunGrantMetadata }): Promise<HttpResponse> {
 const prefix = '/api/agent/v1/runs/' + encodeURIComponent(required.grant.runId);
 if (required.request.method === 'GET' && required.request.path === prefix + '/context' && required.grant.capabilities.includes('context')) {
  const result = await required.callbacks.context({ grant: required.grant });
  return { status: result.ok ? 200 : 403, body: result };
 }
 if (required.request.method === 'POST' && required.request.path === prefix + '/events' && required.grant.capabilities.includes('events')) {
  return sandboxEvents(required);
 }
 return { status: 403, body: { ok: false, error: { code: 'forbidden', message: 'Sandbox run capability unavailable', retryable: false } } };
}

/** Event payload parsing stays lazy and follows exact route/capability admission. */
async function sandboxEvents(required: { request: HttpRequest; callbacks: SandboxCallbacks; grant: RunGrantMetadata }): Promise<HttpResponse> {
  const body = required.request.readBody ? await required.request.readBody({}) : { ok: true as const, value: required.request.body };
  if (!body.ok) return { status: 400, body };
  const event = parseBoundary({ schema: runEventSchema, input: body.value });
  if (!event.ok) return { status: 400, body: event };
  const result = await required.callbacks.record({ grant: required.grant, event: event.value });
  return { status: result.ok ? 200 : 409, body: result };
}
