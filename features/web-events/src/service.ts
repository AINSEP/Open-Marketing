import { notImplemented } from "@open-marketing/contracts";
import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { CollectionAuthorityPort, VisitTokenPort, WebEventRepoPort } from "./ports.js";
import type { WebEventService } from "./types.js";

/** Inert scaffold; all methods return not_implemented without I/O.
 * @example createWebEventService({ repo, tokens, collectionAuthority, clock, ids })
 * @complexity O(1) time/space; no effects. */
export function createWebEventService(_required: { repo: WebEventRepoPort; tokens: VisitTokenPort; collectionAuthority: CollectionAuthorityPort; clock: ClockPort; ids: IdPort }): WebEventService {
  return {
    async recordTouch() { return notImplemented({ operation: "web-events.recordTouch" }); },
    async bindVisitor() { return notImplemented({ operation: "web-events.bindVisitor" }); },
    async touchesFor() { return notImplemented({ operation: "web-events.touchesFor" }); },
  };
}
