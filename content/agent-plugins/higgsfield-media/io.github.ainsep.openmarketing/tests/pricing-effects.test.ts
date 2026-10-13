import { describe, expect, it } from "vitest";
import { bindHiggsfieldEffect, createChargeObservation, createHiggsfieldDispatchEvidence, createHiggsfieldQuote, observedCreditCharge } from "../src/index.js";
import { binding, fixture, intent, NOW, pricing, value } from "./fixtures.js";

describe("Higgsfield cost and verified effect evidence", () => {
  it("supplies known money provenance and binds both original and wire arguments", () => {
    const f = fixture();
    expect(f.dependencies.quote).toMatchObject({ status: "known", estimated: { minorUnits: 25, currency: "USD" }, pricingEvidenceId: pricing.evidenceId });
    const evidence = value({ outcome: createHiggsfieldDispatchEvidence({ dependencies: f.dependencies }) });
    expect(evidence.effect).toMatchObject({ operationId: intent.operationId, effects: ["write", "generation"], accountId: null, moneyExposure: null });
    expect(evidence.quote.argumentsDigest).toBe(evidence.effect.argumentsDigest);
    expect(evidence.originalArgumentsDigest).toBe(intent.argumentsDigest);
    expect(evidence.quote.argumentsDigest).not.toBe(intent.argumentsDigest);
    expect(evidence.arguments).toEqual({ params: { model: intent.model, prompt: intent.prompt, count: 1, aspect_ratio: "1:1", seed: 42 } });
  });
  it.each([null, { ...pricing, accountId: "other" }, { ...pricing, model: "other" }, { ...pricing, configurationDigest: "f".repeat(64) },
    { ...pricing, generationSchemaFingerprint: "f".repeat(64) }, { ...pricing, argumentsDigest: "f".repeat(64) }, { ...pricing, observedAt: NOW + 1 }])("fails unknown pricing closed: %j", evidence => {
    expect(value({ outcome: createHiggsfieldQuote({ binding, intent, pricing: evidence, now: NOW, quoteId: "q" }) })).toMatchObject({ status: "unknown", estimated: null, upperBound: null });
  });
  it("expires a known quote at the exact evidence boundary without retaining reusable money", () => {
    expect(value({ outcome: createHiggsfieldQuote({ binding, intent, pricing: { ...pricing, expiresAt: NOW }, now: NOW, quoteId: "q" }) })).toMatchObject({ status: "expired", estimated: null, upperBound: null, expiresAt: NOW });
  });
  it("never infers zero dollars from a missing conversion rate or an expired credit rate", () => {
    const input = { credits: 1.25, binding, intent, now: NOW };
    expect(observedCreditCharge({ ...input, pricing: null })).toBeNull();
    expect(observedCreditCharge({ ...input, pricing: { ...pricing, creditRate: null } })).toBeNull();
    expect(observedCreditCharge({ ...input, pricing: { ...pricing, expiresAt: NOW } })).toBeNull();
    expect(observedCreditCharge({ ...input, pricing })).toEqual({ minorUnits: 25, currency: "USD" });
    expect(observedCreditCharge({ ...input, credits: 0.000001, pricing })).toEqual({ minorUnits: 1, currency: "USD" });
    expect(observedCreditCharge({ ...input, credits: 0.0000001, pricing })).toBeNull();
    expect(observedCreditCharge({ ...input, credits: -1, pricing })).toBeNull();
  });
  it("generation cannot elect a read classification, different schema, or stale authority", () => {
    const f = fixture();
    const input = { binding, toolName: "generate_image", operationId: intent.operationId, argumentsDigest: "f".repeat(64), intentArgumentsDigest: intent.argumentsDigest,
      schemaFingerprint: binding.generationSchemaFingerprint, quote: f.dependencies.quote, now: NOW };
    expect(value({ outcome: bindHiggsfieldEffect(input) }).effects).toEqual(["write", "generation"]);
    expect(bindHiggsfieldEffect({ ...input, schemaFingerprint: "f".repeat(64) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(bindHiggsfieldEffect({ ...input, intentArgumentsDigest: "0".repeat(64) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(bindHiggsfieldEffect({ ...input, now: f.dependencies.quote.expiresAt })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(bindHiggsfieldEffect({ ...input, toolName: "show_plans_and_credits" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(bindHiggsfieldEffect({ ...input, quote: null })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(value({ outcome: bindHiggsfieldEffect({ ...input, toolName: "job_status", schemaFingerprint: binding.statusSchemaFingerprint, quote: null }) }).effects).toEqual(["read"]);
  });
  it("deduplicates observation identity across status retries but does not conceal conflicting amounts", () => {
    const input = { operationId: "op", providerJobId: "job", kind: "actual" as const, amount: { minorUnits: 25, currency: "USD" }, pricingEvidenceId: "pricing", quoteId: "q", providerChargeEvidenceId: "charge" };
    const original = createChargeObservation(input);
    expect(createChargeObservation(input)).toEqual(original);
    expect(createChargeObservation({ ...input, amount: { minorUnits: 100, currency: "USD" } }).observationId).toBe(original.observationId);
  });
});
