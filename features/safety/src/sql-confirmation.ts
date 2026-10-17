/** Durable exact cards over the server's serialized transaction port; no driver or effects at import. */
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome, ConfirmationCard, Page } from "@open-marketing/contracts";
import { parseBoundary } from "@open-marketing/contracts";
import type { ConfirmationExchangePort } from "./ports.js";
import type { SafetySqlDatabase, SafetySqlSession } from "./sql.js";
import { cardListSchema, cardReadSchema, makeCard, storedCardSchema, validateAnswer, validateAuthority } from "./confirmation.js";
import type { StoredCard } from "./confirmation.js";
import { failure, success, validContext } from "./rules.js";

/** Parse bounded database payloads before restoring authority. @complexity O(b), b <=256KiB. */
function readCard(required: { row: Readonly<Record<string, unknown>> }): StoredCard {
 if (typeof required.row.payload !== "string" || required.row.payload.length > 262144) throw new Error("Invalid card storage");
 return storedCardSchema.parse(JSON.parse(required.row.payload));
}
/** Scoped indexed lookup; the transaction caller owns serialization. @complexity O(b) payload parsing. */
async function loadCard(required: { session: SafetySqlSession; context: CallContext; cardId: string }): Promise<StoredCard | undefined> {
 const result = await required.session.query({ sql: "SELECT payload FROM safety_confirmations WHERE owner_id=$1 AND workspace_id=$2 AND card_id=$3", parameters: [required.context.scope.ownerId, required.context.scope.workspaceId, required.cardId] });
 return result.rows[0] ? readCard({ row: result.rows[0] }) : undefined;
}
/** Immutable answers and scoped revocation share the memory adapter's validation.
 * The supplied db must serialize transactions; SQL/storage failures grant no authority.
 * @example createSqlConfirmationExchange({ db: safetyDb, clock, ids });
 * @complexity Reads <=101 cards/page; <=10,000 retained cards/scope, <=256KiB/card.
 */
export function createSqlConfirmationExchange(required: { db: SafetySqlDatabase; clock: ClockPort; ids: IdPort; ttlMs?: number }): ConfirmationExchangePort {
 /** Map driver exceptions to a typed denial; server db instrumentation retains correlation IDs. */
 async function transact<T>(input: { context: CallContext; ownerOnly?: boolean; execute(required: { session: SafetySqlSession }): Promise<Outcome<T>> }, options?: CallOptions): Promise<Outcome<T>> {
  if (!validContext(input)) return failure({ message: "Invalid confirmation scope" });
  if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Confirmation cancelled" });
  try { return await required.db.transaction(input); }
  catch { return failure({ code: "unavailable", message: "Confirmation storage unavailable; no authority granted" }); }
 }
 return {
  async list(input, options) {
   const parsed = parseBoundary({ schema: cardListSchema, input });
   if (!parsed.ok) return parsed;
   const { context, query } = parsed.value;
   return transact<Page<ConfirmationCard>>({ context, ownerOnly: true, execute: async ({ session }) => {
    const result = await session.query({ sql: "SELECT payload FROM safety_confirmations WHERE owner_id=$1 AND workspace_id=$2 AND status='pending' AND expires_at>$3 AND card_id>$4 ORDER BY card_id LIMIT $5", parameters: [context.scope.ownerId, context.scope.workspaceId, required.clock.now({}), query.cursor ?? "", query.limit + 1] });
    const cards = result.rows.map(row => readCard({ row }).card);
    const items = cards.slice(0, query.limit);
    return success({ value: { items, cursor: cards.length > query.limit ? items.at(-1)!.cardId : null } });
   } }, options);
  },
  async get(input, options) {
   const parsed = parseBoundary({ schema: cardReadSchema, input });
   if (!parsed.ok) return parsed;
   return transact<ConfirmationCard | null>({ context: input.context, ownerOnly: true, execute: async ({ session }) => {
    const stored = await loadCard({ ...input, session });
    return success({ value: stored?.card ?? null });
   } }, options);
  },
  async present(input, options) {
   const created = makeCard({ ...required, ...input });
   if (!created.ok) return created;
   const stored = created.value;
   const payload = JSON.stringify(stored);
   if (payload.length > 262144) return failure({ code: "limit_exceeded", message: "Card storage bound exceeded" });
   return transact<ConfirmationCard>({ context: input.context, execute: async ({ session }) => {
    const count = await session.query({ sql: "SELECT COUNT(*) AS total FROM safety_confirmations WHERE owner_id=$1 AND workspace_id=$2", parameters: [input.context.scope.ownerId, input.context.scope.workspaceId] });
    const total = Number(count.rows[0]?.total);
    if (!Number.isSafeInteger(total) || total < 0) return failure({ code: "unavailable", message: "Invalid confirmation capacity" });
    if (total >= 10000) return failure({ code: "limit_exceeded", message: "Confirmation capacity reached" });
    await session.query({ sql: "INSERT INTO safety_confirmations (owner_id, workspace_id, card_id, status, expires_at, payload) VALUES ($1,$2,$3,'pending',$4,$5)", parameters: [input.context.scope.ownerId, input.context.scope.workspaceId, stored.card.cardId, stored.card.expiresAt, payload] });
    return success({ value: stored.card });
   } }, options);
  },
  confirm: (input, options) => transact<void>({ context: input.context, ownerOnly: true, execute: async ({ session }) => {
   const stored = await loadCard({ context: input.context, cardId: input.response.cardId, session });
   const checked = validateAnswer({ ...input, stored, now: required.clock.now({}) });
   if (!checked.ok) return checked;
   stored!.choice = input.response.choice;
   await session.query({ sql: "UPDATE safety_confirmations SET status='answered', payload=$1 WHERE owner_id=$2 AND workspace_id=$3 AND card_id=$4", parameters: [JSON.stringify(stored), input.context.scope.ownerId, input.context.scope.workspaceId, input.response.cardId] });
   return success({ value: undefined });
  } }, options),
  verify: (input, options) => transact<void>({ context: input.context, execute: async ({ session }) => {
   const stored = await loadCard({ context: input.context, cardId: input.request.approvalId, session });
   return validateAuthority({ ...input, stored, now: required.clock.now({}) });
  } }, options),
  revoke: (input, options) => transact<void>({ context: input.context, execute: async ({ session }) => {
   const parsed = parseBoundary({ schema: cardReadSchema, input });
   if (!parsed.ok) return parsed;
   await session.query({ sql: "DELETE FROM safety_confirmations WHERE owner_id=$1 AND workspace_id=$2 AND card_id=$3", parameters: [input.context.scope.ownerId, input.context.scope.workspaceId, input.cardId] });
   return success({ value: undefined });
  } }, options),
 };
}
