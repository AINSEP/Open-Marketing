import type { ClockPort, Outcome } from "@open-marketing/contracts";
import type { CredentialRepoPort } from "./ports.js";
import type { CredentialRecord, ConnectionSummary } from "./types.js";
import { boundary, failure, lookupSchema, sameScope, scopeKey, storeSchema } from "./rules.js";

/** In-memory repository double. No durability; versions/CAS and revocation match SQL.
 * Deterministic zero clock is test-only default. @complexity O(1) indexed operations, O(records) space.
 */
export function createMemoryCredentialRepo(required: { clock?: ClockPort; maxRecords?: number }): CredentialRepoPort {
  const records = new Map<string, CredentialRecord>();
  const revokedAt = new Map<string, number>();
  const limit = required.maxRecords ?? 10000;
  return {
    async get(input, options) {
      return boundary<ConnectionSummary | null>({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const record = records.get(scopeKey({ scope: input.context.scope, connectionId: input.connectionId }));
        return { ok: true, value: record ? structuredClone(record.summary) : null };
      } }, options);
    },
    async getSecret(input, options) {
      return boundary<CredentialRecord | null>({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (input.context.principal.kind !== "service") return failure({ code: "forbidden" });
        const record = records.get(scopeKey({ scope: input.context.scope, connectionId: input.connectionId }));
        if (!record || record.summary.status !== "connected") return { ok: true, value: null };
        return { ok: true, value: structuredClone(record) };
      } }, options);
    },
    async store(input, options) {
      return boundary({ run: async () => {
        if (!storeSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (!sameScope({ left: input.context.scope, right: input.reference.scope })) return failure({ code: "forbidden" });
        const key = scopeKey(input.reference);
        const current = records.get(key);
        const allowed = canStore({ current, input });
        if (!allowed.ok) return allowed;
        if (!current && records.size >= limit) return failure({ code: "limit_exceeded" });
        const summary: ConnectionSummary = { connectionId: input.reference.connectionId, scope: structuredClone(input.reference.scope), pluginId: input.pluginId, status: "connected" };
        records.set(key, structuredClone({ summary, reference: input.reference, secret: input.secret }));
        return { ok: true, value: structuredClone(summary) };
      } }, options);
    },
    async revoke(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const key = scopeKey({ scope: input.context.scope, connectionId: input.connectionId });
        const record = records.get(key);
        if (!record) return failure({ code: "forbidden" });
        const at = revokedAt.get(key) ?? required.clock?.now({}) ?? 0;
        records.set(key, { ...record, summary: { ...record.summary, status: "revoked" }, secret: { ...record.secret, ciphertext: "revoked" } });
        revokedAt.set(key, at);
        return { ok: true, value: { connectionId: input.connectionId, revokedAt: at } };
      } }, options);
    },
    async requireReconnect(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const key = scopeKey({ scope: input.context.scope, connectionId: input.connectionId });
        const record = records.get(key);
        if (!record || record.summary.status === "revoked") return failure({ code: "forbidden" });
        const summary: ConnectionSummary = { ...record.summary, status: "reconnect_required" };
        records.set(key, { ...record, summary });
        return { ok: true, value: structuredClone(summary) };
      } }, options);
    },
  };
}
/** CAS rules prevent refresh from restoring revoked or stale records. @complexity O(1). */
export function canStore(required: { current?: CredentialRecord; input: Parameters<CredentialRepoPort["store"]>[0] }): Outcome<void> {
  if (required.input.secret.version !== required.input.reference.version) return failure({ code: "invalid_input" });
  if (required.current && required.current.summary.status !== "connected") return failure({ code: "forbidden" });
  if (required.current && required.current.summary.pluginId !== required.input.pluginId) return failure({ code: "conflict" });
  const expected = (required.current?.reference.version ?? 0) + 1;
  if (required.input.reference.version !== expected) return failure({ code: "conflict" });
  return { ok: true, value: undefined };
}
