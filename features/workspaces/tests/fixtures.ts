import type { AccountBinding, CallContext, IdPort, Outcome, WorkspaceRepository } from "../index.js";

export const ownerScope = { ownerId: "owner-a", workspaceId: "workspace-a" };
export const otherScope = { ownerId: "owner-b", workspaceId: "workspace-b" };
export const secondScope = { ownerId: "owner-a", workspaceId: "workspace-second" };
export const sessions = [{ ownerId: "owner-a", sessionId: "session-a" }, { ownerId: "owner-b", sessionId: "session-b" }];
export const workspaces = [ownerScope, otherScope, secondScope];
export const connections = [{ scope: ownerScope, connectionId: "connection-a" }, { scope: ownerScope, connectionId: "connection-a2" }, { scope: otherScope, connectionId: "connection-b" }, { scope: secondScope, connectionId: "connection-second" }];
export const binding: AccountBinding = { id: "binding-a", scope: ownerScope, connectionId: "connection-a", externalAccountId: "vendor-42" };
export interface RepositoryHarness { repo: WorkspaceRepository; dispose(): void }
/** Instance-local deterministic IDs; no wall clock or random source in fixtures. */
export function createIds(required: Record<string, never>): IdPort {
  let sequence = 0;
  return { next() { sequence += 1; return `id-${sequence}`; } };
}
/** A successful precondition must be established before making the behavior assertion. */
export function unwrap<T>(required: { result: Outcome<T> }): T {
  if (!required.result.ok) throw new Error(`Unexpected fixture failure: ${required.result.error.code}`);
  return required.result.value;
}
export async function resolveOwner(required: { repo: WorkspaceRepository }): Promise<CallContext> {
  return unwrap({ result: await required.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: "workspace-a" }) });
}
