import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import type { Outcome, CallContext, ClockPort, IdPort, ConfirmationCard, GenerationCostQuote } from "@open-marketing/contracts";
import { createMemorySafetyRepo, createSqlSafetyRepo, createMemoryConfirmationExchange, createMemoryAccountDispatchLock, createMemoryPlatformLimitEvidence, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createMemorySafetyAudit, createSafetyService, digestArguments } from "../index.js";
import type { ApprovalAnswer, SafetyRepoPort, EffectRequest, FrozenDispatchRequest, FrozenGenerationRequest, VerifiedStopFixture, SafetyService, PlatformLimitEvidence } from "../index.js";
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const approver = { kind: "local_token" as const, ownerId: context.scope.ownerId, deviceId: "fixture-device", tokenId: "fixture-token-reference" };
export const otherContext: CallContext = { ...context, scope: { ownerId: "other", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "other" } };
export const NOW = Date.parse("2026-10-01T19:00:00Z");
export const pluginDigest = "b".repeat(64);
export const schemaFingerprint = "c".repeat(64);
/** Fail loudly on an unexpected typed error so negative tests cannot hide a broken fixture. */
export function unwrap<T>(required: { outcome: Outcome<T> }): T {
 if (!required.outcome.ok) throw new Error(required.outcome.error.code + ": " + required.outcome.error.message);
 return required.outcome.value;
}
/** Fixed injected time and deterministic IDs; changes never use wall time. */
export function timing(required: { now?: number; prefix?: string } = {}) {
 let now = required.now ?? NOW;
 let next = 0;
 const answers: { context: CallContext; answer: ApprovalAnswer }[] = [];
 async function recordAnswer(input: { context: CallContext; answer: ApprovalAnswer }): Promise<Outcome<void>> {
  // SQL callbacks also receive a live session; only detached audit evidence is recorded.
  answers.push(structuredClone({ context: input.context, answer: input.answer }));
  return { ok: true, value: undefined };
 }
 const clock: ClockPort = { now() { return now; } };
 const ids: IdPort = { next() { return `${required.prefix ?? "fixture"}-${++next}`; } };
 return { clock, ids, answers, recordAnswer, ownerTimezone: "America/Los_Angeles", setNow(input: { now: number }) { now = input.now; } };
}
/** One precise activation call and conservative platform cap. */
export function spendRequest(required: { operationId?: string; amount?: number; arguments?: Record<string, unknown>; now?: number } = {}): EffectRequest {
 const args = required.arguments ?? { action: "activate", campaignId: "campaign", budget: required.amount ?? 600 };
 const now = required.now ?? NOW;
 return { arguments: args, pluginDigest, schemaFingerprint, operationScope: "campaign-activation.v1", envelope: { operationId: required.operationId ?? "operation", connectionId: "connection", accountId: "account", effects: ["write", "ad_spend"], argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }), moneyExposure: { amount: { minorUnits: required.amount ?? 600, currency: "USD" }, window: { start: now - 1000, end: now + 86_400_000 } }, requiredLimit: { evidenceId: "evidence", amount: { minorUnits: 1000, currency: "USD" }, timezone: "America/Los_Angeles", semantics: "hard_limit" } } };
}
/** Evidence is independently stored; it is never inferred from the approval. */
export function capEvidence(required: { request?: EffectRequest; now?: number } = {}): PlatformLimitEvidence {
 const request = required.request ?? spendRequest(required);
 return { evidenceId: "evidence", accountId: "account", amount: { minorUnits: 1000, currency: "USD" }, window: request.envelope.moneyExposure!.window, observedAt: required.now ?? NOW, semantics: "hard_limit", pluginDigest };
}
/** Quote carries matching configuration and exact arguments, not an arbitrary zero charge. */
export function generationRequest(required: { operationId?: string; amount?: number; now?: number; status?: GenerationCostQuote["status"] } = {}): EffectRequest & { generation: { request: FrozenGenerationRequest; quote: GenerationCostQuote } } {
 const args = { prompt: "sunrise", model: "image-v1", operation: required.operationId ?? "generation" };
 const argumentsDigest = unwrap({ outcome: digestArguments({ arguments: args }) });
 const request = { operationId: required.operationId ?? "generation", connectionId: "generation-connection", argumentsDigest, configurationDigest: schemaFingerprint };
 const quote: GenerationCostQuote = { quoteId: `quote:${request.operationId}`, pluginId: "image-plugin", pluginDigest, modelConfigurationDigest: request.configurationDigest, argumentsDigest, estimated: { minorUnits: required.amount ?? 600, currency: "USD" }, upperBound: { minorUnits: required.amount ?? 600, currency: "USD" }, pricingEvidenceId: "pricing-v1", expiresAt: (required.now ?? NOW) + 86_400_000, status: required.status ?? "known" };
 return { arguments: args, pluginDigest, schemaFingerprint, operationScope: "image-generation.v1", generation: { request, quote }, envelope: { operationId: request.operationId, connectionId: request.connectionId, accountId: null, effects: ["write", "generation"], argumentsDigest, moneyExposure: null, requiredLimit: null } };
}
/** Test-only SQLite in-memory driver; production code sees the db-shaped port, never this driver. */
export function sqliteFixture(required: Record<string, never> = {}) {
 let failJournal = false;
 const fixture = createSqliteFixture({ migrations: [
  readFileSync(new URL("../migrations/0001_safety.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_confirmations.sql", import.meta.url), "utf8"),
 ] }, { beforeQuery(input) {
  if (failJournal && input.text.startsWith("INSERT INTO safety_journal")) throw new Error("journal fault");
 } });
 return { db: fixture.native, port: fixture.database, setJournalFailure(input: { fail: boolean }) { failJournal = input.fail; }, close: fixture.close };
}
export type Harness = ReturnType<typeof createHarness>;
/** The same suite supplies a repository implementation; every other seam remains a scoped memory double. */
export function createHarness(required: { backend: "memory" | "sql"; now?: number }) {
 const time = timing(required);
 const sqlite = required.backend === "sql" ? sqliteFixture() : null;
 const repo: SafetyRepoPort = sqlite ? createSqlSafetyRepo({ ...time, db: sqlite.port, observer: { observe() {} } }) : createMemorySafetyRepo(time);
 const confirmations = createMemoryConfirmationExchange(time);
 const locks = createMemoryAccountDispatchLock(time);
 const audit = createMemorySafetyAudit({});
 function service(input: { requests?: readonly EffectRequest[]; evidence?: PlatformLimitEvidence[]; stops?: VerifiedStopFixture[]; policyAllowed?: boolean; auditFail?: boolean } = {}): SafetyService {
  const requests = input.requests ?? [spendRequest({ now: time.clock.now({}) })];
  const quotes = requests.filter(request => request.generation).map(request => ({ scope: context.scope, ...request.generation!, pluginDigest: request.pluginDigest, schemaFingerprint: request.schemaFingerprint }));
  return createSafetyService({ repo, confirmations, accountLocks: locks, audit: input.auditFail ? createMemorySafetyAudit({ fail: true }) : audit, clock: time.clock, ids: time.ids, policy: createMemorySpendPolicy({ allowed: input.policyAllowed }), effects: createMemoryVerifiedEffectResolver({ effects: requests.map(request => ({ scope: context.scope, request, envelope: request.envelope })), quotes, stops: input.stops }), platformLimits: createMemoryPlatformLimitEvidence({ evidence: (input.evidence ?? [capEvidence({ now: time.clock.now({}) })]).map(evidence => ({ scope: context.scope, evidence })) }) }, { haltServiceId: "halt-worker", costServiceId: "cost-observer" });
 }
 return { time, repo, confirmations, locks, audit, service, sqlite, close() { sqlite?.close(); } };
}
/** Owner approval is exercised through the real exchange, not forged by the test. */
export async function approve(required: { harness: Harness; service: SafetyService; request: EffectRequest; choice?: "allow" | "allow_chat" | "always_allow" }): Promise<FrozenDispatchRequest> {
 const card = unwrap({ outcome: await required.service.prepareApproval({ context, request: required.request }) });
 unwrap({ outcome: await required.harness.confirmations.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: required.choice ?? "allow" } }) });
 return { ...required.request, approvalId: card.cardId, policyRevision: 0 };
}
