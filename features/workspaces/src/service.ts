import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { IdentityPort, WorkspaceObserverPort, WorkspaceRepoPort } from "./ports.js";
import type { AccountBinding, SessionReference, WorkspaceService } from "./types.js";
import { callPort, observe } from "./boundary.js";
import { failure, ownsContext, sameBinding, sameContext, sameScope } from "./rules.js";
import { bindSchema, bindingSchema, identitySchema, resolveSchema } from "./schemas.js";

type IssuedContext = { readonly session: SessionReference; readonly snapshot: CallContext; readonly issuedAt: number };

/** Authenticate workspace access and bind owned accounts without an extra approval ceremony.
 * bindAccount accepts only the exact context object returned by this instance; serialized or
 * copied claims must first be resolved again by the server. Sessions are rechecked before writes.
 * @example const result = await service.resolveContext({ session: { sessionId: "server-session" }, workspaceId: "workspace" });
 * @complexity O(1) per call plus injected ports; weak keys allow unused contexts to be collected.
 */
export function createWorkspaceService(required: { repo: WorkspaceRepoPort; identity: IdentityPort; ids: IdPort; clock: ClockPort }, optional?: { observer?: WorkspaceObserverPort }): WorkspaceService {
  const issued = new WeakMap<CallContext, IssuedContext>();
  return {
    async resolveContext(input, options) {
      const traceResult = readTrace({ ids: required.ids });
      if (!traceResult.ok) return traceResult;
      const trace = traceResult.value;
      const parsed = parseBoundary({ schema: resolveSchema, input });
      if (!parsed.ok) {
        observe({ observer: optional?.observer, operation: "workspaces.resolveContext", result: parsed, context: trace });
        return parsed;
      }
      const result = await resolveAuthenticated({ ...required, input: parsed.value }, options);
      if (result.ok) {
        const now = readClock({ clock: required.clock });
        if (!now.ok) return now;
        const context = { ...result.value, ...trace };
        issued.set(context, { session: parsed.value.session, snapshot: structuredClone(context), issuedAt: now.value });
        observe({ observer: optional?.observer, operation: "workspaces.resolveContext", result: { ok: true, value: context }, context });
        return { ok: true, value: context };
      }
      observe({ observer: optional?.observer, operation: "workspaces.resolveContext", result, context: trace });
      return result;
    },
    async bindAccount(input, options) {
      const parsed = parseBoundary({ schema: bindSchema, input });
      if (!parsed.ok) return parsed;
      const proof = issued.get(input.context);
      if (!proof || !sameContext({ left: parsed.value.context, right: proof.snapshot })) return failure({ code: "forbidden", message: "Server-resolved context required" });
      const result = await bindAuthenticated({ ...required, input: parsed.value, proof }, options);
      observe({ observer: optional?.observer, operation: "workspaces.bindAccount", result, context: proof.snapshot });
      return result;
    },
  };
}

/** Verify identity before resolving, then reject mismatched repository authority. @complexity O(1), two port calls. */
async function resolveAuthenticated(required: { repo: WorkspaceRepoPort; identity: IdentityPort; input: Parameters<WorkspaceService["resolveContext"]>[0] }, optional?: CallOptions): Promise<Outcome<CallContext>> {
  const parsed = parseBoundary({ schema: resolveSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const identity = await callPort({ invoke: () => required.identity.verify({ session: parsed.value.session }, optional), schema: identitySchema }, optional);
  if (!identity.ok) return identity;
  if (identity.value.sessionId !== parsed.value.session.sessionId) return failure({ code: "unauthenticated", message: "Identity session mismatch" });
  const context = await callPort({ invoke: () => required.repo.resolve(parsed.value, optional), schema: callContextSchema }, optional);
  if (!context.ok) return context;
  const expectedScope = { ownerId: identity.value.ownerId, workspaceId: parsed.value.workspaceId };
  if (!ownsContext({ context: context.value }) || !sameScope({ left: context.value.scope, right: expectedScope })) return failure({ code: "forbidden", message: "Repository identity or workspace mismatch" });
  return context;
}

/** Recheck the live session and immutable scope immediately before binding. Five-minute context lifetime.
 * @complexity O(1), two port calls; no retry on unknown storage outcomes.
 */
async function bindAuthenticated(required: { repo: WorkspaceRepoPort; identity: IdentityPort; clock: ClockPort; input: Parameters<WorkspaceService["bindAccount"]>[0]; proof: IssuedContext }, optional?: CallOptions): Promise<Outcome<AccountBinding>> {
  const now = readClock({ clock: required.clock });
  if (!now.ok) return now;
  const age = now.value - required.proof.issuedAt;
  if (age < 0 || age >= 300_000) return failure({ code: "expired", message: "Resolve workspace context again" });
  if (!sameScope({ left: required.input.binding.scope, right: required.proof.snapshot.scope })) return failure({ code: "forbidden", message: "Account binding scope mismatch" });
  const identity = await callPort({ invoke: () => required.identity.verify({ session: required.proof.session }, optional), schema: identitySchema }, optional);
  if (!identity.ok) return identity;
  if (identity.value.ownerId !== required.proof.snapshot.scope.ownerId || identity.value.sessionId !== required.proof.session.sessionId) return failure({ code: "unauthenticated", message: "Identity changed since resolution" });
  const result = await callPort({ invoke: () => required.repo.bind(required.input, optional), schema: bindingSchema }, optional);
  if (result.ok && !sameBinding({ left: result.value, right: required.input.binding })) return failure({ code: "unavailable", message: "Repository binding mismatch" });
  return result;
}

/** Reject invalid/throwing injected clocks instead of silently disabling expiration. @complexity O(1). */
function readClock(required: { clock: ClockPort }): Outcome<number> {
  try { return parseBoundary({ schema: epochSchema, input: required.clock.now({}) }); }
  catch { return failure({ code: "unavailable", message: "Workspace clock unavailable" }); }
}

/** Trace IDs are generated once at entry and preserved on typed identity failures. @complexity O(1). */
function readTrace(required: { ids: IdPort }): Outcome<Pick<CallContext, "correlationId" | "traceId">> {
  try {
    const context = z.strictObject({ correlationId: idSchema, traceId: idSchema }).safeParse({ correlationId: required.ids.next({}), traceId: required.ids.next({}) });
    if (!context.success) return failure({ code: "unavailable", message: "Workspace trace IDs invalid" });
    return { ok: true, value: { correlationId: context.data.correlationId, traceId: context.data.traceId } };
  } catch { return failure({ code: "unavailable", message: "Workspace trace IDs unavailable" }); }
}
