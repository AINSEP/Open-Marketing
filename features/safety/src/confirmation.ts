import type { ApproverRef, Scope, CallContext, ConfirmationCard, ClockPort, IdPort, Outcome, ApprovalResponse } from "@open-marketing/contracts";
import { approverRefSchema, scopeSchema, epochSchema, confirmationCardSchema, approvalResponseSchema, callContextSchema, idSchema, pageQuerySchema, parseBoundary } from "@open-marketing/contracts";
import { z } from "zod";
import type { ConfirmationExchangePort } from "./ports.js";
import type { EffectRequest, FrozenDispatchRequest } from "./types.js";
import { choices, classify, digestArguments, effectRequestSchema, failure, sameValue, scopeKey, success, validContext } from "./rules.js";
/** Persisted exact request, immutable answer and scope; validated by the SQL adapter. */
export const confirmInputSchema = z.strictObject({ context: callContextSchema, response: approvalResponseSchema, approver: approverRefSchema });
const approvalAnswerSchema = confirmInputSchema.omit({ context: true }).extend({ answeredAt: epochSchema });
export type ApprovalAnswer = z.infer<typeof approvalAnswerSchema>;
export const storedCardSchema = z.strictObject({ context: callContextSchema, request: effectRequestSchema, card: confirmationCardSchema, revision: z.number().int().nonnegative(), answer: approvalAnswerSchema.nullable() });
export type StoredCard = Omit<z.infer<typeof storedCardSchema>, "request"> & { request: EffectRequest };
/** Shared scoped read/revocation boundary. */
export const cardReadSchema = z.strictObject({ context: callContextSchema, cardId: idSchema });
/** Shared bounded owner pagination boundary. */
export const cardListSchema = z.strictObject({ context: callContextSchema, query: pageQuerySchema });
export type MemoryConfirmationExchange = ConfirmationExchangePort & { reset(required: Record<string, never>): void };
const answerAuthoritySchema = z.strictObject({ card: z.strictObject({ scope: scopeSchema }), approver: z.strictObject({ context: callContextSchema, reference: approverRefSchema }) });
/** Check trusted owner authority, not merely reference kind. Parsing alone never authenticates.
 * @param required Card scope and server-authenticated caller/reference.
 * @returns Forbidden for agents/services, scope drift or malformed references. @complexity O(1), bounded IDs. */
export function mayAnswer(required: { card: { scope: Scope }; approver: { context: CallContext; reference: ApproverRef } }): Outcome<void> {
 const parsed = answerAuthoritySchema.safeParse(required);
 if (!parsed.success) return failure({ message: "Invalid approver identity" });
 const { card, approver } = parsed.data;
 if (!validContext({ context: approver.context, ownerOnly: true })) return failure({ message: "Confirmation requires scoped owner" });
 if (!sameValue({ left: card.scope, right: approver.context.scope })) return failure({ message: "Approver differs from card scope" });
 if (approver.reference.kind === "local_token" && approver.reference.ownerId !== card.scope.ownerId) return failure({ message: "Approver differs from card owner" });
 return success({ value: undefined });
}
/** Snapshot the complete answer before any awaited effect. @complexity O(1), bounded IDs/digest. */
export function makeAnswer(required: { response: ApprovalResponse; approver: ApproverRef; answeredAt: number }): Outcome<ApprovalAnswer> {
 return parseBoundary({ schema: approvalAnswerSchema, input: required });
}
/** Validate exact reviewed values before either adapter creates a card. @complexity O(n log n), n <=64KiB. */
export function makeCard(required: { context: CallContext; request: EffectRequest; policyRevision?: number; classification?: ConfirmationCard["classification"]; clock: ClockPort; ids: IdPort; ttlMs?: number }): Outcome<StoredCard> {
 if (!validContext(required) || !effectRequestSchema.safeParse(required.request).success) return failure({ code: "invalid_input", message: "Invalid approval request" });
 const digest = digestArguments({ arguments: required.request.arguments });
 if (!digest.ok || digest.value !== required.request.envelope.argumentsDigest) return failure({ message: "Reviewed values differ from argument digest" });
 const classification = required.classification ?? classify({ envelope: required.request.envelope });
 const card: ConfirmationCard = { cardId: required.ids.next({}), operationId: required.request.envelope.operationId, argumentsDigest: digest.value, arguments: structuredClone(required.request.arguments) as ConfirmationCard["arguments"], allowedChoices: choices({ classification, grantable: !!required.request.operationScope }), expiresAt: required.clock.now({}) + (required.ttlMs ?? 300_000), classification };
 return success({ value: { context: structuredClone(required.context), request: structuredClone(required.request), card, revision: required.policyRevision ?? 0, answer: null } });
}
/** Validate a response without changing it; each adapter commits the first answer once. @complexity O(1). */
export function validateAnswer(required: { stored?: StoredCard; context: CallContext; response: ApprovalResponse; approver: ApproverRef; now: number }): Outcome<void> {
 if (!validContext({ context: required.context, ownerOnly: true }) || !approvalResponseSchema.safeParse(required.response).success) return failure({ message: "Confirmation requires scoped owner" });
 const stored = required.stored;
 if (!stored || scopeKey({ context: stored.context }) !== scopeKey(required)) return failure({ message: "Card not found in scope" });
 const eligible = mayAnswer({ card: { scope: stored.context.scope }, approver: { context: required.context, reference: required.approver } });
 if (!eligible.ok) return eligible;
 if (stored.card.expiresAt <= required.now) return failure({ code: "expired", message: "Confirmation expired" });
 if (!matchesResponse({ stored, response: required.response })) return failure({ message: "Response differs from exact card or choices" });
 if (stored.answer !== null) return failure({ code: "conflict", message: "Card response is immutable" });
 return success({ value: undefined });
}
/** Shared dispatch validation; corrupt, expired or unconfirmed authority fails closed. @complexity O(n log n), bounded DTOs. */
export function validateAuthority(required: { stored?: StoredCard; context: CallContext; request: FrozenDispatchRequest; classification: ConfirmationCard["classification"]; now: number }): Outcome<void> {
 if (!required.stored || !validContext(required)) return failure({ message: "Missing confirmed authority" });
 if (required.stored.card.expiresAt <= required.now) return failure({ code: "expired", message: "Authority expired" });
 if (!matchesAuthority({ ...required, stored: required.stored })) return failure({ message: "Frozen dispatch differs from confirmed authority" });
 return success({ value: undefined });
}
/** Exact authority binds scope, run, values, implementation, and policy. General grants cannot authorize spend. @complexity O(n log n), n <=64KiB. */
export function matchesAuthority(required: { stored: StoredCard; context: CallContext; request: FrozenDispatchRequest; classification: ConfirmationCard["classification"] }): boolean {
 const stored = required.stored;
 if (scopeKey({ context: stored.context }) !== scopeKey(required) || stored.revision !== required.request.policyRevision) return false;
 const answer = readAnswer({ stored });
 if (!answer || answer.response.choice === "cancel") return false;
 const choice = answer.response.choice;
 if (choice === "allow_chat" && (!stored.context.runId || stored.context.runId !== required.context.runId)) return false;
 const { approvalId: _approval, policyRevision: _revision, campaignApproval, ...request } = required.request;
 if (campaignApproval) return matchesCampaignConstituent({ ...required, request, reference: campaignApproval });
 if (stored.card.classification !== required.classification) return false;
 if (choice === "allow") return sameValue({ left: stored.request, right: request });
 return matchesGrant({ stored: stored.request, request });
}
/** Only an exact Allow on the owning spend card covers its frozen, non-serving child calls.
 * Parent-dependent arguments must already be plugin-verified; no substitution or wildcard is admitted here.
 * @complexity O(b) bounded JSON comparison, at most 16 constituents. */
function matchesCampaignConstituent(required: { stored: StoredCard; request: EffectRequest; classification: ConfirmationCard["classification"]; reference: NonNullable<FrozenDispatchRequest["campaignApproval"]> }): boolean {
 const { stored, reference } = required;
 if (stored.answer?.response.choice !== "allow" || stored.card.classification !== "spend" || required.classification !== "write") return false;
 if (stored.card.operationId !== reference.operationId || stored.card.argumentsDigest !== reference.argumentsDigest) return false;
 const call = stored.request.pausedCampaignCalls?.[reference.index];
 return !!call && sameValue({ left: call, right: required.request });
}
/** Grant projection binds one admitted tool scope and configuration, not an arbitrary schema-equivalent tool. @complexity O(n log n), bounded DTOs. */
function matchesGrant(required: { stored: EffectRequest; request: EffectRequest }): boolean {
 if (!required.stored.operationScope || required.stored.operationScope !== required.request.operationScope) return false;
 const identity = required.stored.pluginDigest === required.request.pluginDigest && required.stored.schemaFingerprint === required.request.schemaFingerprint;
 const target = required.stored.envelope.connectionId === required.request.envelope.connectionId && required.stored.envelope.accountId === required.request.envelope.accountId;
 const effects = sameValue({ left: required.stored.envelope.effects, right: required.request.envelope.effects });
 const configuration = required.stored.generation?.request.configurationDigest === required.request.generation?.request.configurationDigest;
 return identity && target && effects && configuration;
}
/** Deterministic approval double; success requires captured audit before storing the answer.
 * @param required Injected time, IDs and required audit callback; callback evidence is detached.
 * @example exchange.confirm({ context: ownerContext, approver, response: { cardId, operationId, argumentsDigest, choice: "allow" } })
 * @complexity O(n log n), bounded payload; <=10,000 cards. */
export function createMemoryConfirmationExchange(required: { clock: ClockPort; ids: IdPort; ttlMs?: number; recordAnswer(required: { context: CallContext; answer: ApprovalAnswer }): Promise<Outcome<void>> }): MemoryConfirmationExchange {
 const cards = new Map<string, StoredCard>();
 const answering = new Set<string>();
 return {
  /** O(n log n), n <=10,000 existing cards; <=100 exact card copies returned. */
  async list(input, options) {
   const parsed = parseBoundary({ schema: cardListSchema, input });
   if (!parsed.ok) return parsed;
   if (!validContext({ context: parsed.value.context, ownerOnly: true })) return failure({ message: "Card reads require scoped owner" });
   if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Card read cancelled" });
   const { context, query } = parsed.value;
   const now = required.clock.now({});
   const pending = [...cards.values()].filter(stored => scopeKey({ context: stored.context }) === scopeKey({ context })
    && stored.answer === null && stored.card.expiresAt > now && stored.card.cardId > (query.cursor ?? ""));
   pending.sort((left, right) => left.card.cardId < right.card.cardId ? -1 : 1);
   const items = pending.slice(0, query.limit).map(stored => structuredClone(stored.card));
   return success({ value: { items, cursor: pending.length > query.limit ? items.at(-1)!.cardId : null } });
  },
  async get(input, options) {
   const parsed = parseBoundary({ schema: cardReadSchema, input });
   if (!parsed.ok) return parsed;
   if (!validContext({ context: parsed.value.context, ownerOnly: true })) return failure({ message: "Card reads require scoped owner" });
   if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Card read cancelled" });
   const stored = cards.get(parsed.value.cardId);
   const inScope = stored && scopeKey({ context: stored.context }) === scopeKey({ context: parsed.value.context });
   return success({ value: inScope ? structuredClone(stored.card) : null });
  },
  async present(input) {
   if (cards.size >= 10_000) return failure({ code: "limit_exceeded", message: "Confirmation capacity reached" });
   const created = makeCard({ ...required, ...input });
   if (!created.ok) return created;
   cards.set(created.value.card.cardId, created.value);
   return success({ value: structuredClone(created.value.card) });
  },
  async confirm(input) {
   const parsed = parseBoundary({ schema: confirmInputSchema, input });
   if (!parsed.ok) return parsed;
   const { context, response, approver } = parsed.value;
   const stored = cards.get(response.cardId);
   const now = required.clock.now({});
   const checked = validateAnswer({ ...parsed.value, stored, now });
   if (!checked.ok) return checked;
   if (answering.has(response.cardId)) return failure({ code: "conflict", message: "Card answer pending" });
   const answer = makeAnswer({ response, approver, answeredAt: now });
   if (!answer.ok) return answer;
   answering.add(response.cardId);
   try {
    const recorded = await required.recordAnswer(structuredClone({ context, answer: answer.value }));
    if (!recorded.ok) return recorded;
    stored!.answer = answer.value;
    return success({ value: undefined });
   } catch { return failure({ code: "unavailable", message: "Approval audit unavailable" }); }
   finally { answering.delete(response.cardId); }
  },
  async verify(input) {
   return validateAuthority({ ...input, stored: cards.get(input.request.approvalId), now: required.clock.now({}) });
  },
  async revoke(input) {
   if (!validContext(input)) return failure({ message: "Revocation requires scoped authority" });
   const stored = cards.get(input.cardId);
   if (stored && scopeKey({ context: stored.context }) === scopeKey(input)) cards.delete(input.cardId);
   return success({ value: undefined });
  },
  reset() { cards.clear(); },
 };
}
/** Exact response fields remain bound on confirmation and restored dispatch. @complexity O(1). */
function matchesResponse(required: { stored: StoredCard; response: ApprovalResponse }): boolean {
 const { card } = required.stored;
 return card.cardId === required.response.cardId && card.operationId === required.response.operationId
  && card.argumentsDigest === required.response.argumentsDigest && card.allowedChoices.includes(required.response.choice);
}
/** Restored authority must contain valid identity bound to this exact card. @complexity O(1). */
function readAnswer(required: { stored: StoredCard }): ApprovalAnswer | null {
 const answer = approvalAnswerSchema.safeParse(required.stored.answer);
 if (!answer.success || !matchesResponse({ stored: required.stored, response: answer.data.response })) return null;
 if (answer.data.approver.kind === "local_token" && answer.data.approver.ownerId !== required.stored.context.scope.ownerId) return null;
 return answer.data;
}
