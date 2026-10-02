import { describe, it, expect } from "vitest";
import type { AccountDispatchLockPort, ConfirmationExchangePort, PlatformLimitEvidencePort, SafetyAuditPort, SafetyRepoPort, SpendPolicyPort, VerifiedEffectResolverPort } from "../../index.js";
import { context, otherContext, spendRequest, capEvidence, timing, unwrap, generationRequest, NOW } from "../fixtures.js";
/** B1 behavioral suite; both memory and SQL MUST preserve the same accounting semantics. */
export function SafetyRepoPortSuite(required: { create: () => { repo: SafetyRepoPort; time: ReturnType<typeof timing>; close: () => void } }) {
 describe("SafetyRepoPort B1", () => {
  it("denies quote/argument mismatch and contradictory upper bounds instead of granting an exact-spend bypass", async () => {
   const fixture = required.create();
   const { request, quote } = generationRequest().generation;
   const mismatched = { ...quote, argumentsDigest: "f".repeat(64) };
   const understated = { ...quote, upperBound: { minorUnits: 500, currency: "USD" } };
   expect(await fixture.repo.assessGeneration({ context, request, quote: mismatched })).toMatchObject({ ok: true, value: { kind: "denied" } });
   expect(await fixture.repo.assessGeneration({ context, request, quote: understated })).toMatchObject({ ok: true, value: { kind: "denied" } });
   fixture.close();
  });
  it("rejects contradictory owner scope at the generation reservation boundary", async () => {
   const fixture = required.create();
   const request = generationRequest().generation;
   const forged = { ...context, principal: { kind: "owner" as const, ownerId: "forged-owner" } };
   expect((await fixture.repo.reserveGeneration({ context: forged, ...request, expectedKind: "normal_write", expectedRevision: 0 })).ok).toBe(false);
   fixture.close();
  });
  it("persists scoped halt and leaves other owners unhalted", async () => {
   const fixture = required.create();
   unwrap({ outcome: await fixture.repo.halt({ context, adAccountId: "account" }) });
   expect(await fixture.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: true } });
   expect(await fixture.repo.snapshot({ context: otherContext, accountId: "account" })).toMatchObject({ ok: true, value: { halted: false } });
   fixture.close();
  });
  it("defaults to $10 in the owner timezone and versions setting edits", async () => {
   const fixture = required.create();
   const settings = unwrap({ outcome: await fixture.repo.getGenerationAllowance({ context }) });
   expect(settings).toEqual({ amount: { minorUnits: 1000, currency: "USD" }, dayTimezone: "America/Los_Angeles", revision: 0 });
   expect(await fixture.repo.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 500, currency: "USD" } } })).toMatchObject({ ok: true, value: { revision: 1 } });
   expect(await fixture.repo.setGenerationAllowance({ context, settings })).toMatchObject({ ok: false, error: { code: "conflict" } });
   fixture.close();
  });
  it("reserves only with independent evidence, retries exactly once, rejects drift", async () => {
   const fixture = required.create();
   const request = { ...spendRequest(), approvalId: "approval", policyRevision: 0 };
   expect((await fixture.repo.reserve({ context, request })).ok).toBe(false);
   const admission = { maximum: { minorUnits: 1000, currency: "USD" }, window: capEvidence().window, expiresAt: NOW + 30_000 };
   const reserved = unwrap({ outcome: await fixture.repo.reserve({ context, request, admission }) });
   expect(unwrap({ outcome: await fixture.repo.reserve({ context, request, admission }) })).toEqual(reserved);
   expect((await fixture.repo.reserve({ context, request: { ...request, arguments: { changed: true } }, admission })).ok).toBe(false);
   expect(await fixture.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { reserved: { minorUnits: 600 }, settled: { minorUnits: 0 } } });
   fixture.close();
  });
  it("retains unresolved generation at midnight and after quote expiry", async () => {
   const fixture = required.create();
   const first = generationRequest();
   const reservation = unwrap({ outcome: await fixture.repo.reserveGeneration({ context, ...first.generation, expectedKind: "normal_write", expectedRevision: 0 }) });
   fixture.time.setNow({ now: Date.parse("2026-10-02T08:00:00Z") });
   const second = generationRequest({ operationId: "later", now: fixture.time.clock.now({}) });
   expect(await fixture.repo.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend" } });
   expect(await fixture.repo.getGenerationReservation({ context, reservationId: reservation.reservationId })).toMatchObject({ ok: true, value: reservation });
   fixture.close();
  });
 });
}
/** Policy boundary tests distinguish read admission and unbounded money. */
export function SpendPolicyPortSuite(required: { create: () => SpendPolicyPort }) {
 describe("SpendPolicyPort B1", () => {
  it("denies unbounded ad spend and typed service effects", async () => {
   const port = required.create();
   const envelope = spendRequest().envelope;
   expect(await port.assess({ context, envelope })).toMatchObject({ ok: true, value: { allowed: true } });
   expect(await port.assess({ context, envelope: { ...envelope, moneyExposure: null } })).toMatchObject({ ok: true, value: { allowed: false } });
   expect(await port.assess({ context, envelope: { ...envelope, effects: ["halt_stop"] } })).toMatchObject({ ok: true, value: { allowed: false } });
  });
 });
}
/** Explicit response, scope and exact arguments are tested against every confirmation adapter. */
export function ConfirmationExchangePortSuite(required: { create: () => ConfirmationExchangePort }) {
 describe("ConfirmationExchangePort B1", () => {
  it("presentation is not confirmation; responses and dispatch must exactly match", async () => {
   const port = required.create();
   const request = spendRequest();
   const card = unwrap({ outcome: await port.present({ context, request }) });
   const dispatch = { ...request, approvalId: card.cardId, policyRevision: 0 };
   expect(card.allowedChoices).toEqual(["allow", "cancel"]);
   expect((await port.verify({ context, request: dispatch, classification: "spend" })).ok).toBe(false);
   expect((await port.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "always_allow" } })).ok).toBe(false);
   unwrap({ outcome: await port.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } }) });
   expect((await port.verify({ context, request: dispatch, classification: "spend" })).ok).toBe(true);
   expect((await port.verify({ context: otherContext, request: dispatch, classification: "spend" })).ok).toBe(false);
   expect((await port.verify({ context, request: { ...dispatch, pluginDigest: "f".repeat(64) }, classification: "spend" })).ok).toBe(false);
  });
 });
}
/** Host bindings never inherit caller-controlled effect hints. */
export function VerifiedEffectResolverPortSuite(required: { create: () => VerifiedEffectResolverPort }) {
 describe("VerifiedEffectResolverPort B1", () => {
  it("matches only admitted scoped exact binding", async () => {
   const port = required.create();
   const request = spendRequest();
   expect((await port.resolve({ context, request })).ok).toBe(true);
   expect((await port.resolve({ context: otherContext, request })).ok).toBe(false);
   expect((await port.resolve({ context, request: { ...request, schemaFingerprint: "e".repeat(64) } })).ok).toBe(false);
  });
 });
}
/** Cap evidence is scoped data; absent accounts fail explicitly. */
export function PlatformLimitEvidencePortSuite(required: { create: () => PlatformLimitEvidencePort }) {
 describe("PlatformLimitEvidencePort B1", () => {
  it("reads only evidence in the admitted account scope", async () => {
   const port = required.create();
   expect(await port.get({ context, accountId: "account" })).toMatchObject({ ok: true, value: capEvidence() });
   expect((await port.get({ context: otherContext, accountId: "account" })).ok).toBe(false);
   expect((await port.get({ context, accountId: "missing" })).ok).toBe(false);
  });
 });
}
/** Lock suite uses barriers, never wall-clock sleeps. */
export function AccountDispatchLockPortSuite(required: { create: () => AccountDispatchLockPort }) {
 describe("AccountDispatchLockPort B1", () => {
  it("serializes acquisition and rejects duplicate release", async () => {
   const port = required.create();
   const first = unwrap({ outcome: await port.acquire({ context, accountId: "account" }) });
   let acquired = false;
   const second = port.acquire({ context, accountId: "account" }).then(result => { acquired = true; return result; });
   await Promise.resolve();
   expect(acquired).toBe(false);
   unwrap({ outcome: await port.release(first) });
   const next = unwrap({ outcome: await second });
   expect(acquired).toBe(true);
   expect((await port.release(first)).ok).toBe(false);
   unwrap({ outcome: await port.release(next) });
  });
  it("cancelled waiter cannot release its predecessor", async () => {
   const port = required.create();
   const first = unwrap({ outcome: await port.acquire({ context, accountId: "account" }) });
   const abort = new AbortController();
   const cancelled = port.acquire({ context, accountId: "account" }, { signal: abort.signal });
   abort.abort();
   expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
   let acquired = false;
   const next = port.acquire({ context, accountId: "account" }).then(result => { acquired = true; return result; });
   await Promise.resolve();
   expect(acquired).toBe(false);
   unwrap({ outcome: await port.release(first) });
   unwrap({ outcome: await port.release(unwrap({ outcome: await next })) });
  });
 });
}
/** Audit success is tied to an append; doubles expose defensive read snapshots. */
export function SafetyAuditPortSuite(required: { create: () => SafetyAuditPort & { read(required: Record<string, never>): readonly unknown[] } }) {
 describe("SafetyAuditPort B1", () => {
  it("appends two correlated outcomes without replacement", async () => {
   const port = required.create();
   unwrap({ outcome: await port.record({ context, operationId: "operation", outcome: "requested" }) });
   unwrap({ outcome: await port.record({ context, operationId: "operation", outcome: "denied" }) });
   expect(port.read({})).toEqual([{ context, operationId: "operation", outcome: "requested" }, { context, operationId: "operation", outcome: "denied" }]);
  });
 });
}
