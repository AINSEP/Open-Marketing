import type { Scope, Outcome, IdPort } from "@open-marketing/contracts";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import { workspaceScopeSchema } from "./schemas.js";
import { failure } from "./rules.js";
import type { AccountBinding } from "./types.js";

/** Trusted provisioning data, owned by the server rather than agent input. */
export type WorkspaceRecord = Scope;
export type WorkspaceConnectionRecord = { readonly scope: Scope; readonly connectionId: string };
/** Repository adapters expose the same resolve/bind/find seam. */
export type WorkspaceRepository = import("./ports.js").WorkspaceRepoPort & import("./ports.js").AccountBindingLookupPort;
/** Internal persistence seam: implementations enforce ownership and uniqueness atomically on bind. */
export interface WorkspaceStore {
  hasWorkspace(required: { scope: Scope }): Promise<boolean>;
  bind(required: { binding: AccountBinding }): Promise<Outcome<AccountBinding>>;
  find(required: { scope: Scope; externalAccountId: string }): Promise<AccountBinding | null>;
}

/** Generate a canonical UUID via the server's injected ID source; no persistence effects.
 * @returns Invalid input for a non-UUID ID; unavailable if the ID source throws.
 * @example createWorkspaceRecord({ ownerId, ids: uuidIds });
 * @complexity O(1) bounded identifiers and one ID-port call.
 */
export function createWorkspaceRecord(required: { ownerId: string; ids: IdPort }): Outcome<WorkspaceRecord> {
  const owner = parseBoundary({ schema: idSchema, input: required.ownerId });
  if (!owner.ok) return owner;
  try {
    return parseBoundary({ schema: workspaceScopeSchema, input: { ownerId: owner.value, workspaceId: required.ids.next({}) } });
  } catch {
    return failure({ code: "unavailable", message: "Workspace ID source unavailable" });
  }
}
