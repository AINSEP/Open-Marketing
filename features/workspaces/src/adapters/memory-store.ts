import type { WorkspaceRepository } from "../store.js";
import { createRepository } from "../repository.js";
import { z } from "zod";
import { idSchema } from "@open-marketing/contracts";
import type { ObserverPort, Outcome, Scope } from "@open-marketing/contracts";
import type { AccountBinding } from "../types.js";
import type { WorkspaceConnectionRecord, WorkspaceRecord, WorkspaceStore } from "../store.js";
import { bindingSchema, workspaceScopeSchema } from "../schemas.js";
import { failure, sameBinding, sameScope } from "../rules.js";

/** Tuple encoding avoids delimiter collisions in opaque identifiers. @complexity O(1) bounded IDs. */
function scopeKey(required: { scope: Scope; id?: string }): string {
  return JSON.stringify([required.scope.ownerId, required.scope.workspaceId, required.id]);
}

/** In-memory storage uses three constant-time indexes and copies at read/write boundaries.
 * Trusted seed configuration is bounded to 10,000 records per collection and throws on invalid
 * references/duplicates. Bind has no awaits between checking and insertion, so concurrent calls
 * cannot overwrite a winner. @complexity O(n) initialization/storage; O(1) lookup/write;
 * listing scans n bindings and sorts k scoped matches in O(n + k log k) time, O(n) space.
 */
export function createMemoryStore(required: { workspaces?: readonly WorkspaceRecord[]; connections?: readonly WorkspaceConnectionRecord[]; bindings?: readonly AccountBinding[] }): WorkspaceStore {
  const seed = z.strictObject({ workspaces: z.array(workspaceScopeSchema).max(10_000), connections: z.array(z.strictObject({ scope: workspaceScopeSchema, connectionId: idSchema })).max(10_000), bindings: z.array(bindingSchema).max(10_000) }).parse({ workspaces: required.workspaces ?? [], connections: required.connections ?? [], bindings: required.bindings ?? [] });
  const workspaces = new Set(seed.workspaces.map(scope => scopeKey({ scope })));
  const connections = new Set(seed.connections.map(record => scopeKey({ scope: record.scope, id: record.connectionId })));
  const byAccount = new Map<string, AccountBinding>();
  const byId = new Map<string, AccountBinding>();
  const workspaceIds = new Set(seed.workspaces.map(scope => scope.workspaceId));
  if (workspaceIds.size !== seed.workspaces.length || connections.size !== seed.connections.length) throw new Error("Duplicate workspace seed");
  for (const connection of seed.connections) {
    if (!workspaces.has(scopeKey({ scope: connection.scope }))) throw new Error("Connection workspace missing");
  }
  function bind(requiredBinding: { binding: AccountBinding }): Outcome<AccountBinding> {
    const { binding } = requiredBinding;
    if (!workspaces.has(scopeKey({ scope: binding.scope })) || !connections.has(scopeKey({ scope: binding.scope, id: binding.connectionId }))) return failure({ code: "forbidden", message: "Connection is not owned by this workspace" });
    const accountKey = scopeKey({ scope: binding.scope, id: binding.externalAccountId });
    const idKey = scopeKey({ scope: binding.scope, id: binding.id });
    const existing = byAccount.get(accountKey) ?? byId.get(idKey);
    if (existing && !sameBinding({ left: existing, right: binding })) return failure({ code: "conflict", message: "Account binding conflicts with an existing binding" });
    const stored = structuredClone(binding);
    byAccount.set(accountKey, stored);
    byId.set(idKey, stored);
    return { ok: true, value: structuredClone(stored) };
  }
  for (const binding of seed.bindings) {
    const result = bind({ binding });
    if (!result.ok) throw new Error("Invalid account binding seed");
  }
  return {
    async hasWorkspace({ scope }) { return workspaces.has(scopeKey({ scope })); },
    async bind(input) { return bind(input); },
    async find({ scope, externalAccountId }) { return structuredClone(byAccount.get(scopeKey({ scope, id: externalAccountId })) ?? null); },
    /** Match SQL keyset ordering and clone results so callers cannot mutate storage. */
    async list({ scope, after, limit }) {
      const rows = [...byId.values()].filter(row => sameScope({ left: row.scope, right: scope }) && row.id > (after ?? ""));
      rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return structuredClone(rows.slice(0, limit));
    },
  };
}

/** Repository double over trusted server seeds. Bind/find are trusted server storage operations; use WorkspaceService
 * to authenticate transport callers. @complexity O(n) seed construction; O(1) lookup/write;
 * O(n + k log k) listing for n stored bindings and k scoped matches.
 * @example createMemoryWorkspaceRepo({ workspaces: [{ ownerId: "owner", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] })
 */
export function createMemoryWorkspaceRepo(required: { workspaces?: readonly WorkspaceRecord[]; connections?: readonly WorkspaceConnectionRecord[]; bindings?: readonly import("../types.js").AccountBinding[] }, optional?: { observer?: ObserverPort }): WorkspaceRepository {
  const store = createMemoryStore(required);
  return createRepository({ store }, optional);
}
