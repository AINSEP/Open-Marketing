import type { CallContext, ClockPort, IdPort } from "@open-marketing/contracts";
import { captureSchema, failure, parseInput, stageSchema, validAttribution } from "./schemas.js";
import type { LeadStageEvent } from "./schemas.js";
import type { LeadsRepoPort, LeadsService } from "./ports.js";

/** Backend lead lifecycle, independent of conversion sharing. Inject time, IDs and storage.
 * Out-of-window evidence freezes unattributed; campaign membership belongs to composition.
 * No services start on import or construction. O(1) work plus bounded repository operations.
 * @example createLeadsService({ repo, clock, ids }).capture({ context, subjectId, source, occurredAt, attribution }) */
export function createLeadsService(required: { repo: LeadsRepoPort; clock: ClockPort; ids: IdPort }): LeadsService {
  const { repo, clock, ids } = required;
  return {
    async capture(input, options) {
      const parsed = parseInput({ schema: captureSchema, input }, options);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      const leadId = ids.next({});
      const eventId = ids.next({});
      const at = clock.now({});
      const attribution = validAttribution(value) ? value.attribution : { campaign: null, touchId: null, touchedAt: null, modelVersion: "last_paid_touch_30d.v1" as const };
      const lead = { scope: value.context.scope, leadId, subjectId: value.subjectId, source: value.source, occurredAt: value.occurredAt, createdAt: at, attribution, stage: "new" as const, revision: 1, lastEventId: eventId, erased: false };
      const event: LeadStageEvent = { ...evidence({ context: value.context }), leadId, eventId, revision: 1, from: null, to: "new", retractsEventId: null, at };
      return repo.capture({ context: value.context, lead, event }, options);
    },
    async setStage(input, options) {
      const parsed = parseInput({ schema: stageSchema, input }, options);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      const loaded = await repo.get({ context: value.context, leadId: value.leadId }, options);
      if (!loaded.ok) return loaded;
      if (!loaded.value) return failure({ code: "unavailable" });
      const current = loaded.value;
      const event: LeadStageEvent = { ...evidence({ context: value.context }), eventId: value.changeId, leadId: value.leadId, revision: value.expectedRevision + 1, from: current.stage, to: value.to, retractsEventId: value.to === "spam" ? current.lastEventId : null, at: clock.now({}) };
      return repo.appendStage({ context: value.context, leadId: value.leadId, expectedRevision: value.expectedRevision, event }, options);
    },
    get: (input, options) => repo.get(input, options),
    list: (input, options) => repo.list(input, options),
    history: (input, options) => repo.history(input, options),
    purgeSubject: (input, options) => repo.purgeSubject(input, options),
  };
}
/** Bounded ID-only audit evidence from the authenticated context; no I/O. */
function evidence(required: { context: CallContext }) {
  const { context } = required;
  return { scope: context.scope, actor: context.principal, correlationId: context.correlationId, traceId: context.traceId, ...(context.runId === undefined ? {} : { runId: context.runId }) };
}
