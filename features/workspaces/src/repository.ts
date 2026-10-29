import { parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, ObserverPort, Outcome, Page } from "@open-marketing/contracts";
import type { AccountBinding } from "./types.js";
import type { WorkspaceRepository, WorkspaceStore } from "./store.js";
import { observe } from "./boundary.js";
import { failure, ownsContext, sameScope } from "./rules.js";
import { bindSchema, findSchema, hasWorkspaceSchema, listBindingsSchema } from "./schemas.js";

/** Repository orchestration; bind/find consume trusted server contexts, never raw transport claims.
 * Storage implementations check ownership at write time. Authentication belongs to WorkspaceService.
 * @complexity Fixed storage calls; O(1) lookup space, O(p) listing space for p <=101 rows.
 */
export function createRepository(required: { store: WorkspaceStore }, optional?: { observer?: ObserverPort }): WorkspaceRepository {
  return {
    async hasWorkspace(input) {
      const parsed = parseBoundary({ schema: hasWorkspaceSchema, input });
      if (!parsed.ok) return parsed;
      const { scope } = parsed.value;
      try {
        return { ok: true, value: await required.store.hasWorkspace({ scope }) };
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
    /** Parse and authorize owner enumeration, then observe its typed storage result. @complexity O(p), p <=101. */
    async listAccountBindings(input, options) {
      const parsed = parseBoundary({ schema: listBindingsSchema, input });
      if (!parsed.ok) return parsed;
      if (!ownsContext({ context: parsed.value.context })) return failure({ code: "forbidden", message: "Owner context required" });
      const result = await listStored({ store: required.store, input: parsed.value }, options);
      observe({ observer: optional?.observer, operation: "workspaces.repo.list", result, context: parsed.value.context });
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

/** Read one scoped page plus lookahead; foreign/excess rows and thrown storage errors fail the whole page.
 * Checks cancellation before storage I/O. @complexity Two storage reads, O(p) result time/space, p <=101.
 */
async function listStored(required: { store: WorkspaceStore; input: import("zod").z.infer<typeof listBindingsSchema> }, optional?: CallOptions): Promise<Outcome<Page<AccountBinding>>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Workspace operation cancelled" });
  const { context, query } = required.input;
  try {
    if (!await required.store.hasWorkspace({ scope: context.scope })) return failure({ code: "forbidden", message: "Workspace is not owned by this identity" });
    const rows = await required.store.list({ scope: context.scope, after: query.cursor, limit: query.limit + 1 });
    if (rows.length > query.limit + 1 || rows.some(row => !sameScope({ left: row.scope, right: context.scope }))) return failure({ code: "unavailable", message: "Invalid workspace adapter result" });
    const items = rows.slice(0, query.limit);
    return { ok: true, value: { items, cursor: rows.length > query.limit ? items[query.limit - 1].id : null } };
  } catch { return failure({ code: "unavailable", message: "Workspace repository unavailable" }); }
}
