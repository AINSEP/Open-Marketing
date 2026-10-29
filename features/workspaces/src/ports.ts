import type { CallContext, CallOptions, Outcome, Page, PageQuery, Scope } from "@open-marketing/contracts";
import type { AccountBinding, SessionReference, VerifiedIdentity } from "./types.js";

/** Trusted server storage boundary: hasWorkspace checks full owner/workspace scope. bind checks
 * current workspace/connection ownership and exact replay/uniqueness atomically. Transport callers
 * must use WorkspaceService; a serialized context or agent-supplied principal is not authority.
 */
export interface WorkspaceRepoPort {
  hasWorkspace(required: { scope: Scope }, optional?: CallOptions): Promise<Outcome<boolean>>;
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
/** Owner-only enumeration of workspace-owned rows, ordered by binding ID; no dispatch authority.
 * Invalid input, forbidden scope, cancellation and storage failures return typed outcomes.
 * @example await repo.listAccountBindings({ context, query: { limit: 25 } });
 */
export interface AccountBindingListPort {
  listAccountBindings(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<AccountBinding>>>;
}
