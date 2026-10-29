import type { ClockPort, ObserverPort } from "@open-marketing/contracts";
import type { PolicyRepoPort } from "./ports.js";
import type { PolicyService } from "./types.js";
import { boundary, failure, validateEvidence, validateRequest } from "./validation.js";

/** Validate authenticated evidence before delegating; no factory I/O or ID replacement.
 * IDs remain ingress-owned for stable retries. Injected time rejects future evidence.
 * @example createPolicyService({ repo, clock }).snapshot({ context, subjectId })
 * @complexity O(n) for repository snapshot, bounded by the adapter; O(1) validation.
 */
export function createPolicyService(
  required: { repo: PolicyRepoPort; clock: ClockPort },
  optional?: { observer?: ObserverPort },
): PolicyService {
  return {
    async snapshot(input, options) {
      return boundary({ context: input.context, operation: "policy.snapshot", observer: optional?.observer, work: async () => {
        const invalid = validateRequest({ context: input.context, subjectId: input.subjectId, options });
        if (invalid) return invalid;
        return required.repo.snapshot(input, options);
      } });
    },
    async appendEvidence(input, options) {
      return boundary({ context: input.context, operation: "policy.appendEvidence", observer: optional?.observer, work: async () => {
        const invalid = validateEvidence({ ...input, options });
        if (invalid) return invalid;
        const now = required.clock.now({});
        if (!Number.isSafeInteger(now) || now < input.evidence.recordedAt) return failure({ code: "invalid_input", message: "Evidence time is invalid or in the future" });
        return required.repo.appendEvidence(input, options);
      } });
    },
  };
}
