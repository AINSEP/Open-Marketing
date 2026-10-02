import { z } from "zod";
import { idSchema, scopeSchema } from "@open-marketing/contracts";
import type { Outcome, Scope } from "@open-marketing/contracts";
import type { AccountBinding } from "../types.js";
import type { WorkspaceConnectionRecord, WorkspaceRecord, WorkspaceStore } from "../store.js";
import { bindingSchema } from "../schemas.js";
import { failure, sameBinding } from "../rules.js";

/** Tuple encoding avoids delimiter collisions in opaque identifiers. @complexity O(1) bounded IDs. */
function scopeKey(required: { scope: Scope; id?: string }): string {
  return JSON.stringify([required.scope.ownerId, required.scope.workspaceId, required.id]);
}

/** In-memory storage uses three constant-time indexes and copies at read/write boundaries.
 * Trusted seed configuration is bounded to 10,000 records per collection and throws on invalid
 * references/duplicates. Bind has no awaits between checking and insertion, so concurrent calls
 * cannot overwrite a winner. @complexity O(n) initialization; O(1) operations; O(n) storage.
 */
export function createMemoryStore(required: { workspaces?: readonly WorkspaceRecord[]; connections?: readonly WorkspaceConnectionRecord[]; bindings?: readonly AccountBinding[] }): WorkspaceStore {
  const seed = z.strictObject({ workspaces: z.array(scopeSchema).max(10_000), connections: z.array(z.strictObject({ scope: scopeSchema, connectionId: idSchema })).max(10_000), bindings: z.array(bindingSchema).max(10_000) }).parse({ workspaces: required.workspaces ?? [], connections: required.connections ?? [], bindings: required.bindings ?? [] });
  const workspaces = new Set(seed.workspaces.map(scope => scopeKey({ scope })));
  const connections = new Set(seed.connections.map(record => scopeKey({ scope: record.scope, id: record.connectionId })));
  const byAccount = new Map<string, AccountBinding>();
  const byId = new Map<string, AccountBinding>();
  if (workspaces.size !== seed.workspaces.length || connections.size !== seed.connections.length) throw new Error("Duplicate workspace seed");
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
  };
}
