import { mcpRequestSchema, parseBoundary, notImplemented } from "@open-marketing/contracts";
import type { Outcome, RunGrantMetadata, ClockPort } from "@open-marketing/contracts";
import type { HttpRequest, HttpResponse } from "../ports.js";
export interface RunGrantVerifierPort { verify(required: { authorization: string | undefined }): Promise<Outcome<RunGrantMetadata>> }
/** Scope comes only from server-verified run grants. No body can widen authority or answer cards. */
export async function handleOmRequest(required: { request: HttpRequest; grants: RunGrantVerifierPort; clock: ClockPort }): Promise<HttpResponse> {
 const grant = await required.grants.verify({ authorization: required.request.authorization });
 if (!grant.ok) return { status: 401, body: grant };
 const metadata = grant.value;
 if (metadata.revoked || metadata.expiresAt <= required.clock.now({})) return { status: 403, body: { ok: false, error: { code: "expired", message: "Run authority unavailable", retryable: false } } };
 if (required.request.path !== "/api/agent/v1/mcp") return { status: 403, body: { ok: false, error: { code: "forbidden", message: "OM route unavailable", retryable: false } } };
 const parsed = parseBoundary({ schema: mcpRequestSchema, input: required.request.body });
 if (!parsed.ok) return { status: 400, body: parsed };
 return { status: 501, body: notImplemented({ operation: "server.om.mcp" }) };
}
