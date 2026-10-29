import { z } from "zod";
import { callContextSchema, campaignKeySchema, epochSchema, idSchema, pageQuerySchema, parseBoundary, principalSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome } from "@open-marketing/contracts";

const opaqueId = idSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const leadStageSchema = z.enum(["new", "qualified", "won", "disqualified", "spam"]);
export const leadSourceSchema = z.strictObject({ kind: z.enum(["form", "call", "booking", "manual"]), ref: opaqueId });
export const leadAttributionSchema = z.strictObject({ campaign: campaignKeySchema.nullable(), touchId: opaqueId.nullable(), touchedAt: epochSchema.nullable(), modelVersion: z.literal("last_paid_touch_30d.v1") })
  .refine(value => value.campaign === null ? value.touchId === null && value.touchedAt === null : value.touchId !== null && value.touchedAt !== null);
export const leadSchema = z.strictObject({ scope: scopeSchema, leadId: opaqueId, subjectId: opaqueId.nullable(), source: leadSourceSchema, occurredAt: epochSchema, createdAt: epochSchema, attribution: leadAttributionSchema, stage: leadStageSchema, revision: epochSchema.min(1), lastEventId: opaqueId, erased: z.boolean() })
  .refine(value => value.erased === (value.subjectId === null))
  .refine(value => validAttribution({ attribution: value.attribution, occurredAt: value.occurredAt }));
/** ID-only append evidence; no addresses, notes, form answers or provider payloads. */
export const leadStageEventSchema = z.strictObject({ scope: scopeSchema, eventId: opaqueId, leadId: opaqueId, revision: epochSchema.min(1), from: leadStageSchema.nullable(), to: leadStageSchema, retractsEventId: opaqueId.nullable(), at: epochSchema, actor: principalSchema, correlationId: idSchema, traceId: idSchema, runId: idSchema.optional() });
export type LeadStage = z.infer<typeof leadStageSchema>;
export type LeadSource = z.infer<typeof leadSourceSchema>;
export type LeadAttribution = z.infer<typeof leadAttributionSchema>;
export type Lead = z.infer<typeof leadSchema>;
export type LeadStageEvent = z.infer<typeof leadStageEventSchema>;
export const captureSchema = z.strictObject({ context: callContextSchema, subjectId: opaqueId, source: leadSourceSchema, occurredAt: epochSchema, attribution: leadAttributionSchema });
export const stageSchema = z.strictObject({ context: callContextSchema, leadId: opaqueId, to: leadStageSchema, expectedRevision: epochSchema.min(1).max(Number.MAX_SAFE_INTEGER - 1), changeId: opaqueId });
export const getSchema = z.strictObject({ context: callContextSchema, leadId: opaqueId });
export const listSchema = z.strictObject({ context: callContextSchema, query: z.strictObject({ stage: leadStageSchema.optional(), page: pageQuerySchema.safeExtend({ cursor: opaqueId.optional() }) }) });
export const historySchema = getSchema.extend({ page: pageQuerySchema.safeExtend({ cursor: z.string().max(16).regex(/^[1-9][0-9]*$/).refine(value => Number.isSafeInteger(Number(value))).optional() }) });
export const purgeSchema = z.strictObject({ context: callContextSchema, subjectId: opaqueId });
export const repoCaptureSchema = z.strictObject({ context: callContextSchema, lead: leadSchema, event: leadStageEventSchema });
export const appendSchema = z.strictObject({ context: callContextSchema, leadId: opaqueId, expectedRevision: stageSchema.shape.expectedRevision, event: leadStageEventSchema })
  .refine(value => value.leadId === value.event.leadId && value.event.revision === value.expectedRevision + 1);

/** Redacted domain/storage failures; no input or driver text escapes. */
export function failure(required: { code: AppError["code"] }): Extract<Outcome<never>, { ok: false }> {
  return { ok: false, error: { code: required.code, message: "Leads operation " + required.code, retryable: false } };
}
/** Parse and snapshot before effects; trusted server contexts establish authority.
 * Returns invalid_input/forbidden/cancelled. O(b) for bounded input bytes, no I/O. */
export function parseInput<T extends { context: CallContext }>(required: { schema: z.ZodType<T>; input: unknown }, optional?: CallOptions): Outcome<T> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const parsed = parseBoundary(required);
  if (!parsed.ok) return parsed;
  const { principal, scope } = parsed.value.context;
  if (principal.kind === "owner" && principal.ownerId !== scope.ownerId) return failure({ code: "forbidden" });
  return parsed;
}
/** Recheck the inclusive evidence window; server composition owns campaign admission.
 * O(1), pure; false means freeze as unattributed rather than lose the enquiry. */
export function validAttribution(required: { attribution: LeadAttribution; occurredAt: number }): boolean {
  const at = required.attribution.touchedAt;
  return at === null || (at <= required.occurredAt && at >= required.occurredAt - 30 * 86400000);
}
/** Match scoped actor and trace evidence, excluding server-generated event time/ID.
 * O(1), pure; adapters reject caller-forged evidence before writing. */
function eventContextMatches(required: { context: CallContext; event: LeadStageEvent }): boolean {
  const { context, event } = required;
  return JSON.stringify(event.scope) === JSON.stringify(context.scope) && JSON.stringify(event.actor) === JSON.stringify(context.principal)
    && event.correlationId === context.correlationId && event.traceId === context.traceId && event.runId === context.runId;
}
/** Initial projection and ledger must describe the same capture. O(1), no effects. */
export function checkCapture(required: { input: z.infer<typeof repoCaptureSchema>; existing: Lead | null }): Outcome<Lead> {
  const { lead, event, context } = required.input;
  if (!eventContextMatches({ context, event }) || JSON.stringify(lead.scope) !== JSON.stringify(context.scope)) return failure({ code: "forbidden" });
  const initial = lead.stage === "new" && lead.revision === 1 && !lead.erased && event.revision === 1 && event.from === null && event.to === "new" && event.retractsEventId === null;
  if (!initial || event.leadId !== lead.leadId || event.eventId !== lead.lastEventId || event.at !== lead.createdAt) return failure({ code: "invalid_input" });
  const existing = required.existing;
  if (!existing) return { ok: true, value: lead };
  if (existing.erased) return failure({ code: "forbidden" });
  if (existing.subjectId !== lead.subjectId || existing.occurredAt !== lead.occurredAt) return failure({ code: "conflict" });
  return { ok: true, value: existing };
}
/** CAS and stable change IDs protect retries; replay never reapplies an old stage.
 * O(1), pure; returns the current projection or the next projection, or typed failure. */
export function checkAppend(required: { input: z.infer<typeof appendSchema>; current: Lead | null; previous: LeadStageEvent | null }): Outcome<Lead> {
  const { input, current, previous } = required;
  if (!eventContextMatches({ context: input.context, event: input.event })) return failure({ code: "forbidden" });
  if (!current) return failure({ code: "unavailable" });
  if (current.erased) return failure({ code: "forbidden" });
  if (previous) return checkStageReplay({ input, current, previous });
  if (current.revision !== input.expectedRevision) return failure({ code: "conflict" });
  const event = input.event;
  const retracts = event.to === "spam" ? current.lastEventId : null;
  if (event.from !== current.stage || event.retractsEventId !== retracts) return failure({ code: "invalid_input" });
  return { ok: true, value: { ...current, stage: event.to, revision: event.revision, lastEventId: event.eventId } };
}
/** Replay identity excludes fresh time/trace metadata, retaining original actor and intent. */
function checkStageReplay(required: { input: z.infer<typeof appendSchema>; current: Lead; previous: LeadStageEvent }): Outcome<Lead> {
  const { input, previous } = required;
  if (previous.leadId !== input.leadId || previous.revision !== input.expectedRevision + 1 || previous.to !== input.event.to || JSON.stringify(previous.actor) !== JSON.stringify(input.context.principal)) return failure({ code: "conflict" });
  return { ok: true, value: required.current };
}
