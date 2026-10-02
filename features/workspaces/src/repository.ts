import { callContextSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, IdPort } from "@open-marketing/contracts";
import type { IdentityPort, WorkspaceObserverPort } from "./ports.js";
import type { WorkspaceRepository, WorkspaceStore } from "./store.js";
import { callPort, observe } from "./boundary.js";
import { failure, ownsContext, sameScope } from "./rules.js";
import { bindSchema, findSchema, identitySchema, resolveSchema } from "./schemas.js";

/** Repository orchestration; bind/find consume trusted server contexts, never raw transport claims.
 * Storage implementations check ownership at write time. Authentication belongs to WorkspaceService.
 * @complexity O(1) indexed lookups per operation, excluding the injected identity implementation.
 */
export function createRepository(required: { store: WorkspaceStore; identity: IdentityPort; ids: IdPort }, optional?: { observer?: WorkspaceObserverPort }): WorkspaceRepository {
  return {
    async resolve(input, options) {
      const parsed = parseBoundary({ schema: resolveSchema, input });
      if (!parsed.ok) return parsed;
      const identity = await callPort({ invoke: () => required.identity.verify({ session: parsed.value.session }, options), schema: identitySchema }, options);
      if (!identity.ok) return identity;
      if (identity.value.sessionId !== parsed.value.session.sessionId) return failure({ code: "unauthenticated", message: "Identity session mismatch" });
      const scope = { ownerId: identity.value.ownerId, workspaceId: parsed.value.workspaceId };
      try {
        if (!await required.store.hasWorkspace({ scope })) return failure({ code: "forbidden", message: "Workspace is not owned by this identity" });
        return parseBoundary({ schema: callContextSchema, input: { scope, principal: { kind: "owner", ownerId: scope.ownerId }, correlationId: required.ids.next({}), traceId: required.ids.next({}) } });
      } catch {
        return failure({ code: "unavailable", message: "Workspace repository unavailable" });
      }
    },
    async bind(input, options) {
      const parsed = parseBoundary({ schema: bindSchema, input });
      if (!parsed.ok) return parsed;
      const { context, binding } = parsed.value;
      if (!ownsContext({ context }) || !sameScope({ left: context.scope, right: binding.scope })) return failure({ code: "forbidden", message: "Account binding scope mismatch" });
      const result = await bindStored({ store: required.store, binding }, options);
      observe({ observer: optional?.observer, operation: "workspaces.repo.bind", result, context });
      return result;
    },
    async find(input, options) {
      const parsed = parseBoundary({ schema: findSchema, input });
      if (!parsed.ok) return parsed;
      if (!ownsContext({ context: parsed.value.context })) return failure({ code: "forbidden", message: "Owner context required" });
      const result = await findStored({ store: required.store, input: parsed.value }, options);
      observe({ observer: optional?.observer, operation: "workspaces.repo.find", result, context: parsed.value.context });
      return result;
    },
  };
}

/** Catch storage exceptions, and check cancellation before starting a write. @complexity O(1) indexed writes. */
async function bindStored(required: { store: WorkspaceStore; binding: import("./types.js").AccountBinding }, optional?: CallOptions) {
  if (optional?.signal?.aborted) return failure<import("./types.js").AccountBinding>({ code: "cancelled", message: "Workspace operation cancelled" });
  try { return await required.store.bind({ binding: required.binding }); }
  catch { return failure<import("./types.js").AccountBinding>({ code: "unavailable", message: "Workspace repository unavailable" }); }
}
/** Scoped read; no account ID is queried globally. @complexity O(1) indexed reads. */
async function findStored(required: { store: WorkspaceStore; input: import("zod").z.infer<typeof findSchema> }, optional?: CallOptions) {
  if (optional?.signal?.aborted) return failure<import("./types.js").AccountBinding | null>({ code: "cancelled", message: "Workspace operation cancelled" });
  try {
    if (!await required.store.hasWorkspace({ scope: required.input.context.scope })) return failure<import("./types.js").AccountBinding | null>({ code: "forbidden", message: "Workspace is not owned by this identity" });
    return { ok: true as const, value: await required.store.find({ scope: required.input.context.scope, externalAccountId: required.input.externalAccountId }) };
  } catch { return failure<import("./types.js").AccountBinding | null>({ code: "unavailable", message: "Workspace repository unavailable" }); }
}
