import { z } from "zod";
import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { CollectionAuthorityPort, VisitTokenPort, WebEventRepoPort } from "./ports.js";
import type { WebEventService } from "./types.js";
import { bindVisit, boundary, failure, mapTouch, validateContext, validateEvent, validateRead, validateSubject, validateVisit } from "./rules.js";

/** Collect one first-party landing, authenticate visit binding and expose scoped attribution.
 * Factory is inert. Authority/token/storage failures are sanitized typed Outcomes.
 * @example createWebEventService({ repo, tokens, collectionAuthority, clock, ids })
 * @complexity Bounded envelope validation; one authority/token call and one repository operation.
 */
export function createWebEventService(required: { repo: WebEventRepoPort; tokens: VisitTokenPort; collectionAuthority: CollectionAuthorityPort; clock: ClockPort; ids: IdPort }): WebEventService {
  return {
    async recordTouch(input, options) {
      return boundary({ options, work: async () => {
        const invalid = validateContext({ context: input.context, options });
        if (invalid) return invalid;
        const parsed = validateEvent(input);
        if (!parsed.ok) return parsed;
        const context = structuredClone(input.context);
        const authority = await required.collectionAuthority.assess({ context: structuredClone(context), event: structuredClone(parsed.value) }, options);
        if (!authority.ok) return authority;
        const decision = z.strictObject({ allowed: z.boolean() }).safeParse(authority.value);
        if (!decision.success || !decision.data.allowed) return failure({ code: "forbidden" });
        if (options?.signal?.aborted) return failure({ code: "cancelled" });
        const event = { ...parsed.value, receivedAt: required.clock.now({}), cursor: 0, traceId: context.traceId };
        const touch = mapTouch({ event, touchId: required.ids.next({}) });
        return required.repo.recordTouch({ context, event, touch }, options);
      } });
    },
    async bindVisitor(input, options) {
      return boundary({ options, work: async () => {
        const invalid = validateSubject({ ...input, options });
        if (invalid) return invalid;
        if (!z.string().min(1).max(4096).safeParse(input.visitToken).success) return failure({ code: "invalid_input" });
        const context = structuredClone(input.context);
        const subjectId = input.subjectId;
        const verified = await required.tokens.verify({ context: structuredClone(context), visitToken: input.visitToken }, options);
        if (!verified.ok) return verified;
        const invalidVisit = validateVisit({ context, visit: verified.value, now: required.clock.now({}), options });
        if (invalidVisit) return invalidVisit;
        const bound = bindVisit({ visit: verified.value, subjectId, now: required.clock.now({}) });
        if (!bound.ok) return bound;
        return required.repo.bindVisitor({ context, visitId: bound.value.visitId, subjectId }, options);
      } });
    },
    async touchesFor(input, options) {
      const invalid = validateRead({ ...input, options });
      if (invalid) return invalid;
      return boundary({ options, work: () => required.repo.touchesFor(input, options) });
    },
  };
}
