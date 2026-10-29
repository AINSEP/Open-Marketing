import { z } from "zod";
import { campaignKeySchema, encodeCampaignKey, epochSchema, parseCampaignKey } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { CollectionAuthorityPort, ObservedCampaignPort, VisitTokenPort, WebEventRepoPort } from "./ports.js";
import type { AttributionTouch, DestinationReadiness, WebEventService } from "./types.js";
import { bindVisit, boundary, destinationIdentity, failure, mapTouch, touchSchema, validateContext, validateEvent, validateRead, validateSubject, validateVisit } from "./rules.js";

/** Collect one first-party landing, authenticate visit binding and expose scoped attribution.
 * Factory is inert. Authority/token/storage failures are sanitized typed Outcomes.
 * @example createWebEventService({ repo, tokens, collectionAuthority, observedCampaigns, clock, ids })
 * @complexity Bounded envelope validation; at most one observed-campaign batch per read/write.
 */
export function createWebEventService(required: { repo: WebEventRepoPort; tokens: VisitTokenPort; collectionAuthority: CollectionAuthorityPort; observedCampaigns: ObservedCampaignPort; clock: ClockPort; ids: IdPort }): WebEventService {
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
        const saved = await required.repo.recordTouch({ context: structuredClone(context), event, touch }, options);
        if (!saved.ok) return saved;
        if (saved.value.eventId !== event.eventId) return failure({ code: "unavailable" });
        const projected = await attributedTouches({ context, touches: [saved.value], observedCampaigns: required.observedCampaigns }, options);
        return projected.ok ? { ok: true, value: projected.value[0] } : projected;
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
      return boundary({ options, work: async () => {
        const context = structuredClone(input.context);
        const saved = await required.repo.touchesFor({ ...input, context: structuredClone(context) }, options);
        if (!saved.ok) return saved;
        if (!Array.isArray(saved.value) || saved.value.length > input.limit) return failure({ code: "unavailable" });
        return attributedTouches({ context, touches: saved.value, observedCampaigns: required.observedCampaigns }, options);
      } });
    },
    async destinationReadiness(input, options) {
      const invalid = validateContext({ context: input.context, options });
      if (invalid) return invalid;
      const destination = destinationIdentity(input);
      if (!destination.ok) return destination;
      return boundary<DestinationReadiness>({ options, work: async () => {
        const heartbeat = await required.repo.lastHeartbeat({ context: structuredClone(input.context), destinationId: destination.value }, options);
        if (!heartbeat.ok) return heartbeat;
        const now = required.clock.now({});
        if (!epochSchema.nullable().safeParse(heartbeat.value).success || !epochSchema.safeParse(now).success) return failure({ code: "unavailable" });
        if (heartbeat.value === null) return { ok: true, value: { status: "missing", heartbeatAt: null } };
        if (heartbeat.value > now) return failure({ code: "unavailable" });
        return { ok: true, value: { status: now - heartbeat.value > 7 * 86400000 ? "stale" : "ready", heartbeatAt: heartbeat.value } };
      } });
    },
  };
}

/** Observation changes affect the returned projection, never stored claims or replay identity.
 * O(n) time/space, n<=100; one scoped batch. Tainted adapter results must be a requested subset. */
async function attributedTouches(required: { context: CallContext; touches: readonly AttributionTouch[]; observedCampaigns: ObservedCampaignPort }, options?: CallOptions): Promise<Outcome<readonly AttributionTouch[]>> {
  if (options?.signal?.aborted) return failure({ code: "cancelled" });
  const parsed = z.array(touchSchema).max(100).safeParse(required.touches);
  if (!parsed.success) return failure({ code: "unavailable" });
  if (parsed.data.length === 0) return { ok: true, value: [] };
  const claims = [...new Set(parsed.data.map(touch => touch.campaignId))];
  const keys = claims.map(value => parseCampaignKey({ value })).flatMap(result => result.ok ? [result.value] : []);
  const result = await required.observedCampaigns.observed({ context: structuredClone(required.context), keys: structuredClone(keys) }, options);
  if (!result.ok) return failure({ code: "unavailable" });
  const observed = z.array(campaignKeySchema).max(100).safeParse(result.value);
  if (!observed.success) return failure({ code: "unavailable" });
  const accepted = observed.data.map(key => encodeCampaignKey({ key })).flatMap(value => value.ok ? [value.value] : []);
  const requested = new Set(claims);
  if (accepted.length !== observed.data.length || accepted.some(value => !requested.has(value))) return failure({ code: "unavailable" });
  if (options?.signal?.aborted) return failure({ code: "cancelled" });
  const membership = new Set(accepted);
  return { ok: true, value: parsed.data.map(touch => ({ ...touch, campaignId: attributedCampaign({ touch, membership }) })) };
}

/** Ordinary OM IDs were scope-verified by ingress; vendor keys still require observation. O(1). */
function attributedCampaign(required: { touch: AttributionTouch; membership: ReadonlySet<string> }): string | null {
  const { touch, membership } = required;
  if (touch.campaignId !== null && !touch.campaignId.startsWith("ck1:")) return touch.campaignId;
  return membership.has(touch.campaignId ?? "") ? touch.campaignId : null;
}
