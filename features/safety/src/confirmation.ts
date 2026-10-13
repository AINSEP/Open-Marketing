import type { CallContext, ConfirmationCard, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { approvalResponseSchema, callContextSchema, idSchema, pageQuerySchema, parseBoundary } from "@open-marketing/contracts";
import { z } from "zod";
import type { ConfirmationExchangePort } from "./ports.js";
import type { EffectRequest, FrozenDispatchRequest } from "./types.js";
import { choices, classify, digestArguments, effectRequestSchema, failure, sameValue, scopeKey, success, validContext } from "./rules.js";
type StoredCard = { context: CallContext; request: EffectRequest; card: ConfirmationCard; revision: number; choice: "allow" | "allow_chat" | "always_allow" | "cancel" | null };
export type MemoryConfirmationExchange = ConfirmationExchangePort & { revoke(required: { context: CallContext; cardId: string }): void; reset(required: Record<string, never>): void };
/** Exact authority binds scope, run, values, implementation, and policy. General grants cannot authorize spend. @complexity O(n log n), n <=64KiB. */
function matchesAuthority(required: { stored: StoredCard; context: CallContext; request: FrozenDispatchRequest; classification: ConfirmationCard["classification"] }): boolean {
 const stored = required.stored;
 if (scopeKey({ context: stored.context }) !== scopeKey(required) || stored.revision !== required.request.policyRevision) return false;
 if (stored.card.classification !== required.classification || stored.choice === null || stored.choice === "cancel") return false;
 if (stored.choice === "allow_chat" && (!stored.context.runId || stored.context.runId !== required.context.runId)) return false;
 const { approvalId: _approval, policyRevision: _revision, ...request } = required.request;
 if (stored.choice === "allow") return sameValue({ left: stored.request, right: request });
 return matchesGrant({ stored: stored.request, request });
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
/** Deterministic approval double. Nothing is approved by present(); authenticated owner response is separate. @example exchange.confirm({ context: ownerContext, response: { cardId, operationId, argumentsDigest, choice: "allow" } }) @complexity O(n log n), bounded payload; <=10,000 cards. */
export function createMemoryConfirmationExchange(required: { clock: ClockPort; ids: IdPort; ttlMs?: number }): MemoryConfirmationExchange {
 const cards = new Map<string, StoredCard>();
 return {
  /** O(n log n), n <=10,000 existing cards; <=100 exact card copies returned. */
  async list(input, options) {
   const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, query: pageQuerySchema }), input });
   if (!parsed.ok) return parsed;
   if (!validContext({ context: parsed.value.context, ownerOnly: true })) return failure({ message: "Card reads require scoped owner" });
   if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Card read cancelled" });
   const { context, query } = parsed.value;
   const now = required.clock.now({});
   const pending = [...cards.values()].filter(stored => scopeKey({ context: stored.context }) === scopeKey({ context })
    && stored.choice === null && stored.card.expiresAt > now && stored.card.cardId > (query.cursor ?? ""));
   pending.sort((left, right) => left.card.cardId < right.card.cardId ? -1 : 1);
   const items = pending.slice(0, query.limit).map(stored => structuredClone(stored.card));
   return success({ value: { items, cursor: pending.length > query.limit ? items.at(-1)!.cardId : null } });
  },
  async get(input, options) {
   const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, cardId: idSchema }), input });
   if (!parsed.ok) return parsed;
   if (!validContext({ context: parsed.value.context, ownerOnly: true })) return failure({ message: "Card reads require scoped owner" });
   if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Card read cancelled" });
   const stored = cards.get(parsed.value.cardId);
   const inScope = stored && scopeKey({ context: stored.context }) === scopeKey({ context: parsed.value.context });
   return success({ value: inScope ? structuredClone(stored.card) : null });
  },
  async present(input) {
   if (!validContext(input) || !effectRequestSchema.safeParse(input.request).success) return failure({ code: "invalid_input", message: "Invalid approval request" });
   const digest = digestArguments({ arguments: input.request.arguments });
   if (!digest.ok || digest.value !== input.request.envelope.argumentsDigest) return failure({ message: "Reviewed values differ from argument digest" });
   if (cards.size >= 10_000) return failure({ code: "limit_exceeded", message: "Confirmation capacity reached" });
   const classification = input.classification ?? classify({ envelope: input.request.envelope });
   const card: ConfirmationCard = { cardId: required.ids.next({}), operationId: input.request.envelope.operationId, argumentsDigest: digest.value, arguments: structuredClone(input.request.arguments) as ConfirmationCard["arguments"], allowedChoices: choices({ classification, grantable: !!input.request.operationScope }), expiresAt: required.clock.now({}) + (required.ttlMs ?? 300_000), classification };
   cards.set(card.cardId, { context: structuredClone(input.context), request: structuredClone(input.request), card, revision: input.policyRevision ?? 0, choice: null });
   return success({ value: structuredClone(card) });
  },
  async confirm(input) {
   if (!validContext({ context: input.context, ownerOnly: true }) || !approvalResponseSchema.safeParse(input.response).success) return failure({ message: "Confirmation requires scoped owner" });
   const stored = cards.get(input.response.cardId);
   if (!stored || scopeKey({ context: stored.context }) !== scopeKey(input)) return failure({ message: "Card not found in scope" });
   if (stored.card.expiresAt <= required.clock.now({})) return failure({ code: "expired", message: "Confirmation expired" });
   if (stored.card.operationId !== input.response.operationId || stored.card.argumentsDigest !== input.response.argumentsDigest || !stored.card.allowedChoices.includes(input.response.choice)) return failure({ message: "Response differs from exact card or choices" });
   if (stored.choice !== null) return failure({ code: "conflict", message: "Card response is immutable" });
   stored.choice = input.response.choice;
   return success({ value: undefined });
  },
  async verify(input) {
   const stored = cards.get(input.request.approvalId);
   if (!stored || !validContext(input)) return failure({ message: "Missing confirmed authority" });
   if (stored.card.expiresAt <= required.clock.now({})) return failure({ code: "expired", message: "Authority expired" });
   if (!matchesAuthority({ ...input, stored })) return failure({ message: "Frozen dispatch differs from confirmed authority" });
   return success({ value: undefined });
  },
  revoke(input) { const stored = cards.get(input.cardId); if (stored && scopeKey({ context: stored.context }) === scopeKey(input)) cards.delete(input.cardId); },
  reset() { cards.clear(); },
 };
}
