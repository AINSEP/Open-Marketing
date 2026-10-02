import type { Scope, Outcome } from "@open-marketing/contracts";
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
