import { z } from "zod";
import { epochSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { ClockPort, IdPort, ObserverEvent, Outcome } from "@open-marketing/contracts";
import type { AccountBindingLookupPort, IdentityPort, WorkspaceObserverPort } from "./ports.js";
import type { VerifiedIdentity } from "./types.js";
import type { WorkspaceConnectionRecord, WorkspaceRecord, WorkspaceRepository } from "./store.js";
import { createMemoryStore } from "./adapters/memory-store.js";
import { createRepository } from "./repository.js";
import { failure } from "./rules.js";
import { callPort } from "./boundary.js";
import { bindingSchema, identitySchema, sessionSchema } from "./schemas.js";

/** Trusted test sessions; this double does not implement login, password hashing, or token minting. */
export type MemorySession = VerifiedIdentity & { readonly expiresAt?: number; readonly revoked?: boolean };
/** Revocation seam for shared identity tests, with all state scoped to the double instance. */
export interface MemoryIdentity extends IdentityPort { revoke(required: { sessionId: string }): void }

/** Session lookup double with injected expiration checks. Empty configuration denies all sessions.
 * Invalid/duplicate seeds throw; verify returns typed unauthenticated/expired/cancelled failures.
 * @example createMemoryIdentity({ sessions: [{ ownerId: "owner", sessionId: "session" }] })
 * @complexity O(n) seed construction, O(1) verification; O(n) bounded storage.
 */
export function createMemoryIdentity(required: { sessions?: readonly MemorySession[]; clock?: ClockPort }): MemoryIdentity {
  const sessions = new Map<string, MemorySession>();
  const seed = z.array(identitySchema.extend({ expiresAt: epochSchema.optional(), revoked: z.boolean().optional() })).max(10_000).parse(required.sessions ?? []);
  for (const session of seed) {
    if (sessions.has(session.sessionId)) throw new Error("Duplicate identity session seed");
    sessions.set(session.sessionId, session);
  }
  return {
    async verify(input, optional) {
      const parsed = parseBoundary({ schema: z.strictObject({ session: sessionSchema }), input });
      if (!parsed.ok) return parsed;
      if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Identity verification cancelled" });
      const session = sessions.get(parsed.value.session.sessionId);
      if (!session || session.revoked) return failure({ code: "unauthenticated", message: "Session not authenticated" });
      const expiration = checkExpiration({ session, clock: required.clock });
      if (!expiration.ok) return expiration;
      return { ok: true, value: { ownerId: session.ownerId, sessionId: session.sessionId } };
    },
    revoke({ sessionId }) {
      idSchema.parse(sessionId);
      const session = sessions.get(sessionId);
      if (session) sessions.set(sessionId, { ...session, revoked: true });
    },
  };
}

/** Expiring sessions need a valid injected clock; no wall-clock fallback. @complexity O(1). */
function checkExpiration(required: { session: MemorySession; clock?: ClockPort }): Outcome<null> {
  if (required.session.expiresAt === undefined) return { ok: true, value: null };
  if (!required.clock) return failure({ code: "unavailable", message: "Identity clock required" });
  try {
    const now = epochSchema.safeParse(required.clock.now({}));
    if (!now.success) return failure({ code: "unavailable", message: "Identity clock invalid" });
    if (now.data >= required.session.expiresAt) return failure({ code: "expired", message: "Session expired" });
    return { ok: true, value: null };
  } catch { return failure({ code: "unavailable", message: "Identity clock unavailable" }); }
}

/** Repository double over trusted server seeds. Missing identity/IDs fails closed rather than
 * fabricating authority. Bind/find are trusted server storage operations; use WorkspaceService
 * to authenticate transport callers. @complexity O(n) seed construction; O(1) operations.
 * @example createMemoryWorkspaceRepo({ identity, ids, workspaces: [{ ownerId: "owner", workspaceId: "workspace" }] })
 */
export function createMemoryWorkspaceRepo(required: { identity?: IdentityPort; ids?: IdPort; workspaces?: readonly WorkspaceRecord[]; connections?: readonly WorkspaceConnectionRecord[]; bindings?: readonly import("./types.js").AccountBinding[] }, optional?: { observer?: WorkspaceObserverPort }): WorkspaceRepository {
  const store = createMemoryStore(required);
  return createRepository({ store, identity: required.identity ?? { async verify() { return failure({ code: "unavailable", message: "Identity adapter required" }); } }, ids: required.ids ?? { next() { return ""; } } }, optional);
}

/** Share the repository's account index instead of maintaining a stale second copy. Empty
 * configuration has no records. @complexity O(1).
 * @example createMemoryAccountBindingLookup({ repo })
 */
export function createMemoryAccountBindingLookup(required: { repo?: AccountBindingLookupPort }): AccountBindingLookupPort {
  return { async find(input, optional) {
    const repo = required.repo;
    if (!repo) return failure({ code: "unavailable", message: "Account binding repository required" });
    return callPort({ invoke: () => repo.find(input, optional), schema: bindingSchema.nullable() }, optional);
  } };
}

/** Trace sink double; caller owns the event buffer. No runtime logging or singleton.
 * @example createMemoryWorkspaceObserver({ events: [] })
 * @complexity O(1) per observation; memory is owned/bounded by the caller's buffer lifecycle.
 */
export function createMemoryWorkspaceObserver(required: { events: ObserverEvent[] }): WorkspaceObserverPort {
  return { observe(event) { required.events.push(structuredClone(event)); } };
}
