import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { ErasureParticipantPort, ErasureParticipantRegistry, PrivacyProcessingBlockPort, PrivacyRepoPort } from "./ports.js";
import type { ErasureRequest, ParticipantProgress, PrivacyService, RetainedSuppressionDigest } from "./types.js";
import { blockOutcomeSchema, boundary, failure, parseRequest, participantOutcomeSchema, phases, progressStatus, sameRecord, scopeKey, validateInput } from "./validation.js";

type Dependencies = { repo: PrivacyRepoPort; participants: ErasureParticipantRegistry; block: PrivacyProcessingBlockPort; clock: ClockPort; ids: IdPort };
type Attempt = Dependencies & { context: CallContext; request: ErasureRequest; options?: CallOptions };

/** Thin erasure orchestration. Requests block processing; each advance runs one phase only.
 * Every result is checkpointed before the next effect. Lost checkpoints require participant replay
 * by scoped request/phase identity. Cross-process subject serialization belongs to server jobs.
 * @example const privacy = createPrivacyService({ repo, participants, block, clock, ids });
 * @complexity O(p+d) bounded state per checkpoint, <=100 sequential participant calls per advance.
 */
export function createPrivacyService(required: Dependencies): PrivacyService {
  const active = new Set<string>();
  return {
    async requestErasure(input, options) {
      const invalid = validateInput({ context: input.context, id: input.subjectId, options });
      if (invalid) return invalid;
      return boundary({ work: () => requestErasure({ ...required, ...input, options }) });
    },
    async advance(input, options) {
      const invalid = validateInput({ context: input.context, id: input.requestId, options });
      if (invalid) return invalid;
      return boundary({ work: async () => {
        const loaded = await loadRequest({ repo: required.repo, ...input, options });
        if (!loaded.ok) return loaded;
        return advanceSubject({ ...required, context: input.context, request: loaded.value, active, options });
      } });
    },
    async status(input, options) {
      const invalid = validateInput({ context: input.context, id: input.requestId, options });
      if (invalid) return invalid;
      return boundary({ work: () => loadRequest({ repo: required.repo, ...input, options }) });
    },
  };
}
/** Persist the frozen inventory before blocking. A block failure leaves a discoverable pending row. */
async function requestErasure(required: Dependencies & { context: CallContext; subjectId: string; options?: CallOptions }): Promise<Outcome<ErasureRequest>> {
  const listed = required.participants.list({});
  if (!listed.ok) return listed;
  if (listed.value.length === 0) return failure({ code: "unavailable", message: "No erasure participants registered" });
  const request: ErasureRequest = { scope: structuredClone(required.context.scope), requestId: required.ids.next({}), subjectId: required.subjectId, requestedAt: required.clock.now({}), phase: "plan", status: "pending", participants: listed.value.map(participant => ({ participantId: participant.id, phase: "plan", status: "pending", removedCount: 0 })), retainedSuppression: [] };
  const parsed = parseRequest({ context: required.context, request });
  if (!parsed.ok) return parsed;
  const created = await persistRequest({ ...required, request: parsed.value, operation: "create" });
  if (!created.ok) return created;
  const blocked = await ensureBlock({ ...required, request: parsed.value });
  return blocked.ok ? { ok: true, value: parsed.value } : blocked;
}
/** Validate injected storage responses as well as SQL payloads before invoking participants. */
async function loadRequest(required: { repo: PrivacyRepoPort; context: CallContext; requestId: string; options?: CallOptions }): Promise<Outcome<ErasureRequest>> {
  const loaded = await required.repo.get({ context: required.context, requestId: required.requestId }, required.options);
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unavailable", message: "Erasure request missing" });
  const parsed = parseRequest({ context: required.context, request: loaded.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.requestId !== required.requestId) return failure({ code: "unavailable", message: "Erasure request ID mismatch" });
  return parsed;
}
/** Validate checkpoint acknowledgements before using their data for the next participant effect. */
async function persistRequest(required: { repo: PrivacyRepoPort; context: CallContext; request: ErasureRequest; operation: "create" | "save"; options?: CallOptions }): Promise<Outcome<ErasureRequest>> {
  const saved = await required.repo[required.operation]({ context: required.context, request: required.request }, required.options);
  if (!saved.ok) return saved;
  const parsed = parseRequest({ context: required.context, request: saved.value });
  if (!parsed.ok) return parsed;
  if (!sameRecord({ left: parsed.value, right: required.request })) return failure({ code: "unavailable", message: "Erasure checkpoint acknowledgement mismatch" });
  return parsed;
}
/** Reject overlap by scoped subject, reload after acquiring the local gate, release on every outcome. */
async function advanceSubject(required: Attempt & { active: Set<string> }): Promise<Outcome<ErasureRequest>> {
  const key = scopeKey({ scope: required.context.scope, id: required.request.subjectId });
  if (required.active.has(key)) return failure({ code: "conflict", message: "Erasure subject already advancing" });
  required.active.add(key);
  try {
    const latest = await loadRequest({ ...required, requestId: required.request.requestId });
    if (!latest.ok) return latest;
    const attempt = { ...required, request: latest.value };
    const blocked = await ensureBlock(attempt);
    if (!blocked.ok) return blocked;
    if (latest.value.status === "complete") return latest;
    const resolved = resolveParticipants(attempt);
    if (!resolved.ok) return resolved;
    return await runPhase({ ...attempt, resolved: resolved.value });
  } finally { required.active.delete(key); }
}
/** The same idempotent dispatch barrier is rechecked on every attempt, including completed ones. */
async function ensureBlock(required: Attempt): Promise<Outcome<void>> {
  const invalid = validateInput({ context: required.context, id: required.request.requestId, options: required.options });
  if (invalid) return invalid;
  const result = await required.block.block({ context: required.context, requestId: required.request.requestId, subjectId: required.request.subjectId }, required.options);
  const parsed = blockOutcomeSchema.safeParse(result);
  return parsed.success ? parsed.data : failure({ code: "unavailable", message: "Invalid processing block result" });
}
/** Resolve the whole frozen inventory before effects; later registrations never join this request. */
function resolveParticipants(required: Attempt): Outcome<ErasureParticipantPort[]> {
  const listed = required.participants.list({});
  if (!listed.ok) return listed;
  const available = new Map(listed.value.map(participant => [participant.id, participant]));
  const resolved: ErasureParticipantPort[] = [];
  for (const progress of required.request.participants.filter(progress => progress.phase === "plan")) {
    const participant = available.get(progress.participantId);
    if (!participant) return failure({ code: "unavailable", message: "Frozen erasure participant missing" });
    resolved.push(participant);
  }
  return { ok: true, value: resolved };
}
/** Sequential checkpoints; completed participants are skipped, pending never opens the next phase. */
async function runPhase(required: Attempt & { resolved: ErasureParticipantPort[] }): Promise<Outcome<ErasureRequest>> {
  let request = required.request;
  for (const participant of required.resolved) {
    const checkpoint = await runParticipant({ ...required, request, participant });
    if (!checkpoint.ok) return checkpoint;
    request = checkpoint.value;
    if (request.participants.some(progress => progress.phase === request.phase && progress.participantId === participant.id && progress.status === "failed")) return checkpoint;
  }
  const current = request.participants.filter(progress => progress.phase === request.phase);
  if (!current.every(progress => progress.status === "complete")) return { ok: true, value: request };
  return persistRequest({ ...required, request: finishPhase({ request }), operation: "save" });
}
/** Failed/unknown outcomes record a failed checkpoint; no later participant effect on this attempt. */
async function runParticipant(required: Attempt & { participant: ErasureParticipantPort }): Promise<Outcome<ErasureRequest>> {
  const previous = required.request.participants.find(progress => progress.phase === required.request.phase && progress.participantId === required.participant.id)!;
  if (previous.status === "complete") return { ok: true, value: required.request };
  const invalid = validateInput({ context: required.context, id: required.request.requestId, options: required.options });
  if (invalid) return invalid;
  const result = await boundary({ work: () => required.participant.run({ context: required.context, requestId: required.request.requestId, subjectId: required.request.subjectId, phase: required.request.phase }, required.options) });
  const parsed = participantOutcomeSchema.safeParse(result);
  const outcome = parsed.success ? parsed.data : failure({ code: "unavailable", message: "Invalid erasure participant result" });
  const update = checkpointRequest({ request: required.request, participantId: required.participant.id, previous, outcome });
  return persistRequest({ ...required, request: update, operation: "save" });
}
/** A late digest or decreasing count fails closed instead of allowing removal to advance. */
function checkpointRequest(required: { request: ErasureRequest; participantId: string; previous: ParticipantProgress; outcome: Outcome<{ complete: boolean; removedCount: number; retainedSuppression?: readonly RetainedSuppressionDigest[] }> }): ErasureRequest {
  const { request, outcome } = required;
  const progress = resultProgress({ previous: required.previous, outcome });
  const participants = request.participants.map(entry => entry.phase === request.phase && entry.participantId === required.participantId ? progress : entry);
  const retainedSuppression = request.phase === "plan" && outcome.ok ? mergeDigests({ previous: request.retainedSuppression, supplied: outcome.value.retainedSuppression ?? [] }) : request.retainedSuppression;
  const status = progressStatus({ phase: request.phase, participants });
  return { ...request, participants, retainedSuppression, status };
}
/** Reject invalid progress independently of the request's other pending/failed checkpoints. */
function resultProgress(required: { previous: ParticipantProgress; outcome: Outcome<{ complete: boolean; removedCount: number; retainedSuppression?: readonly RetainedSuppressionDigest[] }> }): ParticipantProgress {
  const { previous, outcome } = required;
  if (!outcome.ok) return { ...previous, status: "failed" };
  if (outcome.value.removedCount < previous.removedCount) return { ...previous, status: "failed" };
  if (previous.phase !== "plan" && (outcome.value.retainedSuppression?.length ?? 0) > 0) return { ...previous, status: "failed" };
  return { ...previous, status: outcome.value.complete ? "complete" : "pending", removedCount: outcome.value.removedCount };
}
function mergeDigests(required: { previous: readonly RetainedSuppressionDigest[]; supplied: readonly RetainedSuppressionDigest[] }): RetainedSuppressionDigest[] {
  const digests = new Map([...required.previous, ...required.supplied].map(digest => [JSON.stringify(digest), digest]));
  return [...digests.values()];
}
/** Open only the next phase after all checkpoints; attest is the sole terminal completion. */
function finishPhase(required: { request: ErasureRequest }): ErasureRequest {
  const { request } = required;
  if (request.phase === "attest") return { ...request, status: "complete" };
  const phase = phases[phases.indexOf(request.phase) + 1];
  const next: ParticipantProgress[] = request.participants.filter(progress => progress.phase === "plan").map(progress => ({ participantId: progress.participantId, phase, status: "pending", removedCount: 0 }));
  return { ...request, phase, status: "pending", participants: [...request.participants, ...next] };
}
