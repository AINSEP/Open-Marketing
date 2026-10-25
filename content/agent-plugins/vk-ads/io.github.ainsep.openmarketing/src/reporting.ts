import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";
import type { VkAccount, VkPage } from "./ports.js";

const id = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const accountSchema = z.object({ id, username: z.string().min(1).max(1024), currency: z.string().min(1).max(32), status: z.enum(["active", "deleted", "blocked"]) });
const pageSchema = z.object({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), offset: z.number().int().min(0).max(1000000), items: z.array(z.object({ id, name: z.string().max(1024) })).max(100) });
/** Validate token identity, strip private/unconsumed fields and reject a foreign account.
 * @returns A normalized identity or a redacted typed failure. O(b) validation, no effects.
 */
export function decodeAccount(required: { input: unknown; accountId: string | null }): Outcome<VkAccount> {
  const parsed = accountSchema.safeParse(required.input);
  if (!parsed.success) return mismatch();
  if (required.accountId !== null && parsed.data.id !== required.accountId) return { ok: false, error: { code: "forbidden", message: "VK token belongs to a different account", retryable: false } };
  return { ok: true, value: parsed.data };
}
/** Validate the entire page atomically: matching offset, bounded size, unique IDs and count.
 * @returns A source-labelled page with explicit continuation, or protocol_mismatch.
 * @complexity O(n) time/space for <=100 records; no automatic paging or metric inference.
 */
export function decodeCampaignPage(required: { input: unknown; accountId: string; limit: number; offset: number; retrievedAt: number }): Outcome<VkPage> {
  const parsed = pageSchema.safeParse(required.input);
  if (!parsed.success) return mismatch();
  const { items, count, offset } = parsed.data;
  if (offset !== required.offset || items.length > required.limit || new Set(items.map(item => item.id)).size !== items.length) return mismatch();
  const end = offset + items.length;
  if (items.length > 0 && end > count) return mismatch();
  if (items.length === 0 && offset < count) return mismatch();
  if (end < count && end > 1000000) return { ok: false, error: { code: "limit_exceeded", message: "VK pagination exceeds the local offset limit", retryable: false } };
  return { ok: true, value: { source: "vk_ads", accountId: required.accountId, retrievedAt: required.retrievedAt, timezone: null, items, nextOffset: end < count ? end : null } };
}
/** Shared private codec failure; no provider text is returned. */
function mismatch(): Outcome<never> { return { ok: false, error: { code: "protocol_mismatch", message: "VK response does not match verified fields", retryable: false } }; }
