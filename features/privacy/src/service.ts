import { notImplemented } from "@open-marketing/contracts";
import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { ErasureParticipantRegistry, PrivacyProcessingBlockPort, PrivacyRepoPort } from "./ports.js";
import type { PrivacyService } from "./types.js";

/** Inert scaffold; does not register participants, block subjects or start workers.
 * @example createPrivacyService({ repo, participants, block, clock, ids })
 * @complexity O(1) time/space; methods return explicit not_implemented. */
export function createPrivacyService(_required: { repo: PrivacyRepoPort; participants: ErasureParticipantRegistry; block: PrivacyProcessingBlockPort; clock: ClockPort; ids: IdPort }): PrivacyService {
  return {
    async requestErasure() { return notImplemented({ operation: "privacy.requestErasure" }); },
    async advance() { return notImplemented({ operation: "privacy.advance" }); },
    async status() { return notImplemented({ operation: "privacy.status" }); },
  };
}
