import type { CallContext, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
/** Opaque authenticated session handle resolved by the server identity adapter. */
export type SessionReference = { readonly sessionId: string };
/** Binding identity is local to its full scope. This contract has no vendor discriminator, so
 * externalAccountId is unique within the workspace; different connections cannot silently rebind it.
 */
export type AccountBinding = { readonly id: string; readonly scope: Scope; readonly connectionId: string; readonly externalAccountId: string };
/** Verified server identity. sessionId must equal the requested reference. */
export type VerifiedIdentity = { readonly ownerId: string; readonly sessionId: string };
/** Owner/workspace authentication independent of agent claims. */
export interface WorkspaceService {
  resolveContext(required: { session: SessionReference; workspaceId: string }, optional?: CallOptions): Promise<Outcome<CallContext>>;
  /** Use the exact context instance returned by this service within five minutes. The server
   * rechecks its session on every bind; raw transport context values must be resolved again.
   */
  bindAccount(required: { context: CallContext; binding: AccountBinding }, optional?: CallOptions): Promise<Outcome<AccountBinding>>;
}
