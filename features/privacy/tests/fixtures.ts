import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createFakeClock } from "@open-marketing/om-clock";
import type { CallContext, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import { createErasureParticipantRegistry, createMemoryPrivacyRepo, createPrivacyService } from "../index.js";
import type { ErasureParticipantPort, ErasurePhase, ErasureRequest, PrivacyProcessingBlockPort, PrivacyRepoPort, RetainedSuppressionDigest } from "../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const digest: RetainedSuppressionDigest = { identifierDigest: "a".repeat(64), keyVersion: "key-1", purpose: "marketing", topic: "news", reason: "erasure" };
export const unavailable = { ok: false, error: { code: "unavailable", message: "Fixture failure", retryable: true } } as const;

/** Independent caller fixture with one frozen participant, no completed work. */
export function initialRequest(required: Partial<ErasureRequest> = {}): ErasureRequest {
  return { scope: structuredClone(context.scope), requestId: "request", subjectId: "subject", requestedAt: 123, phase: "plan", status: "pending", participants: [{ participantId: "contacts", phase: "plan", status: "pending", removedCount: 0 }], retainedSuppression: [], ...required };
}
/** Unwrap assertions without silently skipping assertions on failure. */
export function valueOf<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(required.outcome.error.code);
  return required.outcome.value;
}
type Call = Parameters<ErasureParticipantPort["run"]>[0];
type Result = Extract<Awaited<ReturnType<ErasureParticipantPort["run"]>>, { ok: true }>;

/** Test participant models pending external removal and idempotent effect replay by scope/request/phase.
 * Local synthetic PII disappears on purge; suppression is supplied before that effect.
 */
export function memoryParticipant(required: { id: string; suppression?: readonly RetainedSuppressionDigest[] }) {
  const calls: Call[] = [];
  const pending = new Set<ErasurePhase>();
  const failed = new Set<ErasurePhase>();
  const completed = new Map<string, Result>();
  const state = { address: "fixture@example.invalid" as string | null, externalPresent: true, purges: 0, removals: 0, attestations: 0 };
  const participant: ErasureParticipantPort = {
    id: required.id,
    async run(input) {
      calls.push(structuredClone(input));
      const key = JSON.stringify([input.context.scope, input.requestId, input.phase]);
      const replay = completed.get(key);
      if (replay) return structuredClone(replay);
      if (failed.has(input.phase)) return unavailable;
      if (pending.has(input.phase)) return { ok: true, value: { complete: false, removedCount: 0 } };
      applyEffect({ state, phase: input.phase });
      const result: Result = { ok: true, value: { complete: true, removedCount: input.phase === "purgeLocal" || input.phase === "externalRemoval" ? 1 : 0, ...(input.phase === "plan" ? { retainedSuppression: required.suppression ?? [] } : {}) } };
      completed.set(key, result);
      return structuredClone(result);
    },
  };
  return { participant, calls, pending, failed, state };
}
function applyEffect(required: { state: { address: string | null; externalPresent: boolean; purges: number; removals: number; attestations: number }; phase: ErasurePhase }): void {
  if (required.phase === "externalRemoval") { required.state.externalPresent = false; required.state.removals += 1; }
  if (required.phase === "purgeLocal") { required.state.address = null; required.state.purges += 1; }
  if (required.phase === "attest") required.state.attestations += 1;
}
/** Deterministic composition with observable dispatch-block state, no real feature adapters. */
export function serviceFixture(required: { repo?: PrivacyRepoPort; members?: ReturnType<typeof memoryParticipant>[] } = {}) {
  const members = required.members ?? [memoryParticipant({ id: "contacts", suppression: [digest] })];
  const participants = createErasureParticipantRegistry({});
  for (const member of members) valueOf({ outcome: participants.register({ participant: member.participant }) });
  const blocked = new Set<string>();
  const blockCalls: Parameters<PrivacyProcessingBlockPort["block"]>[0][] = [];
  const controls = { failBlock: false };
  const block: PrivacyProcessingBlockPort = { async block(input) {
    blockCalls.push(structuredClone(input));
    if (controls.failBlock) return unavailable;
    blocked.add(JSON.stringify([input.context.scope, input.subjectId]));
    return { ok: true, value: undefined };
  } };
  const clock = createFakeClock({ initial: 123 });
  let sequence = 0;
  const ids = { next() { sequence += 1; return `request-${sequence}`; } };
  const repo = required.repo ?? createMemoryPrivacyRepo({});
  const dependencies = { repo, participants, block, clock, ids };
  return { ...dependencies, service: createPrivacyService(dependencies), members, blocked, blockCalls, controls };
}

/** Real :memory: SQLite transaction owner; returned failed Outcomes and throws roll back.
 * Joined sessions expire at root completion; concurrent roots serialize through this fixture.
 * Only this test fixture applies the lane migration, exclusively to its own temporary database.
 */
export function sqliteFixture(_required: Record<string, never>) {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_privacy.sql", import.meta.url), "utf8"));
  let tail: Promise<unknown> = Promise.resolve();
  const unitOfWork: UnitOfWork = { async transaction({ work }) {
    const result = tail.then(async () => {
      db.exec("BEGIN IMMEDIATE");
      const lifetime = { active: true };
      const session = sqliteSession({ db, lifetime });
      try {
        const value = await work({ session });
        const failed = typeof value === "object" && value !== null && "ok" in value && value.ok === false;
        db.exec(failed ? "ROLLBACK" : "COMMIT");
        return value;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { lifetime.active = false; }
    });
    tail = result.catch(() => undefined);
    return result;
  } };
  return { db, unitOfWork, close: () => db.close() };
}
/** Narrow foreign driver ABI: numbered OM placeholders bind in statement order. */
function sqliteSession(required: { db: Database.Database; lifetime: { active: boolean } }): SqlSession {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      if (!required.lifetime.active) throw new Error("Session released");
      const statement = required.db.prepare(input.text.replace(/\$\d+/g, "?"));
      if (statement.reader) return { rows: statement.all(...(input.values ?? [])) as Row[], rowCount: null };
      return { rows: [] as Row[], rowCount: statement.run(...(input.values ?? [])).changes };
    },
    async transaction({ work }) {
      if (!required.lifetime.active) throw new Error("Session released");
      return work({ session: this });
    },
  };
}
