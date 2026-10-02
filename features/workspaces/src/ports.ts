import type { CallContext, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { AccountBinding, SessionReference, VerifiedIdentity } from "./types.js";

/** Trusted server storage boundary: resolve verifies session/workspace ownership. bind checks
 * current workspace/connection ownership and exact replay/uniqueness atomically. Transport callers
 * must use WorkspaceService; a serialized context or agent-supplied principal is not authority.
 */
export interface WorkspaceRepoPort {
  resolve(required: { session: SessionReference; workspaceId: string }, optional?: CallOptions): Promise<Outcome<CallContext>>;
  bind(required: { context: CallContext; binding: AccountBinding }, optional?: CallOptions): Promise<Outcome<AccountBinding>>;
}
/** Verify an opaque server session reference using server-owned identity state. Never infer the
 * owner from browser/agent claims. Revoked/expired/unknown sessions return typed failures.
 */
export interface IdentityPort {
  verify(required: { session: SessionReference }, optional?: CallOptions): Promise<Outcome<VerifiedIdentity>>;
}
/** Trusted server read boundary. Match full owner/workspace scope plus external account ID;
 * equal vendor IDs in other scopes are unrelated. Callers supply a server-authenticated context.
 */
export interface AccountBindingLookupPort {
  find(required: { context: CallContext; externalAccountId: string }, optional?: CallOptions): Promise<Outcome<AccountBinding | null>>;
}
/** Best-effort trace sink; implementations must not expose sessions or credentials. */
export type WorkspaceObserverPort = ObserverPort;
