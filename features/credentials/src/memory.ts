import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CredentialAuditPort, CredentialBrokerPort, CredentialRefreshPort, CredentialRepoPort, CredentialLockPort, KeyringPort, SecretSealerPort } from "./ports.js";
import type { CredentialReference } from "./types.js";
import { boundary, configurationSchema, failure, referenceSchema } from "./rules.js";
import { createCredentialBroker } from "./broker.js";
import { createMemoryCredentialRepo } from "./memory-repo.js";
import { createMemoryCredentialLock } from "./locks.js";
import { createMemorySecretSealer } from "./memory-sealer.js";
export { createMemorySecretSealer } from "./memory-sealer.js";
export { createMemoryCredentialRepo } from "./memory-repo.js";
export { createMemoryCredentialLock } from "./locks.js";
export { createMemoryOAuthClient } from "./memory-oauth.js";

/** Deterministic version-one key double; unknown versions fail explicitly. @complexity O(key length). */
export function createMemoryKeyring(required: { keys?: ReadonlyMap<number, Uint8Array> }): KeyringPort {
  const keys = new Map(required.keys ?? [[1, new Uint8Array(32).fill(7)]]);
  return {
    async resolve(input, options) {
      return boundary({ run: async () => {
        if (!configurationSchema.safeParse(input.configuration).success) return failure({ code: "invalid_input" });
        if (!referenceSchema.shape.version.safeParse(input.version).success) return failure({ code: "invalid_input" });
        const key = keys.get(input.version);
        if (!key || key.length !== 32) return failure({ code: "unavailable" });
        return { ok: true, value: key.slice() };
      } }, options);
    },
  };
}
const auditSchema = z.strictObject({ context: callContextSchema, operation: z.enum(["credentials.connect", "credentials.revoked", "credentials.use"]), connectionId: idSchema });
type AuditEntry = Parameters<CredentialAuditPort["record"]>[0];
/** Append-only metadata double with inspectable snapshots. @complexity O(1) append, O(entries) snapshots; capped. */
export function createMemoryCredentialAudit(required: { maxEntries?: number }): CredentialAuditPort & { entries(required: Record<string, never>): readonly AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    async record(input, options) {
      return boundary({ run: async () => {
        if (!auditSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (entries.length >= (required.maxEntries ?? 10000)) return failure({ code: "limit_exceeded" });
        entries.push(structuredClone(input));
        return { ok: true, value: undefined };
      } }, options);
    },
    entries() { return structuredClone(entries); },
  };
}
/** Broker double uses the production orchestration against injected in-memory boundaries. @complexity O(1). */
export function createMemoryCredentialBroker(required: { repo?: CredentialRepoPort; locks?: CredentialLockPort; audit?: CredentialAuditPort; sealer?: SecretSealerPort; refresh?: CredentialRefreshPort }): CredentialBrokerPort {
  return createCredentialBroker({ repo: required.repo ?? createMemoryCredentialRepo({}), locks: required.locks ?? createMemoryCredentialLock({}), audit: required.audit ?? createMemoryCredentialAudit({}), sealer: required.sealer ?? createMemorySecretSealer({}), refresh: required.refresh });
}
/** Refresh double advances exactly the configured versions; useful for racing callers. @complexity O(1). */
export function createMemoryCredentialRefresh(required: { sealer: SecretSealerPort; dueVersions?: readonly number[]; revoked?: boolean }): CredentialRefreshPort & { calls(required: Record<string, never>): number } {
  let calls = 0;
  const due = new Set(required.dueVersions ?? []);
  return {
    async refresh(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled" });
      if (required.revoked) return failure({ code: "unauthenticated" });
      if (!due.has(input.record.reference.version)) return { ok: true, value: null };
      calls++;
      const reference: CredentialReference = { ...input.record.reference, version: input.record.reference.version + 1 };
      return required.sealer.seal({ reference, plaintext: "test-refreshed-token" }, options);
    },
    calls() { return calls; },
  };
}

/** Redacted observer double; exposes only metadata snapshots. @complexity O(1) append, bounded to 10000 events. */
export function createMemoryCredentialObserver(required: Record<string, never>): import("@open-marketing/contracts").ObserverPort & { events(required: Record<string, never>): readonly import("@open-marketing/contracts").ObserverEvent[] } {
  const events: import("@open-marketing/contracts").ObserverEvent[] = [];
  return {
    observe(input) {
      if (events.length >= 10000) return;
      events.push(structuredClone(input));
    },
    events() { return structuredClone(events); },
  };
}
