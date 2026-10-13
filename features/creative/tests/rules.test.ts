import { describe, it, expect } from "vitest";
import { digestGenerationRequest } from "../index.js";
import { context, NOW, generationRequest, quoteFor, value } from "./support/fixtures.js";
import { parseGeneration, validateQuote } from "../src/rules.js";

describe("Reviewed generation argument boundaries", () => {
  it("hashes object keys canonically and excludes approval handles", () => {
    const left = generationRequest({ parameters: { width: 512, quality: "high" } });
    const right = generationRequest({ parameters: { quality: "high", width: 512 } });
    expect(left.argumentsDigest).toBe(right.argumentsDigest);
    expect(value({ outcome: digestGenerationRequest({ request: { ...left, approvalId: "approval" } }) })).toBe(left.argumentsDigest);
    expect(generationRequest({ prompt: "different" }).argumentsDigest).not.toBe(generationRequest().argumentsDigest);
  });
  it("rejects cycles, excessive text, non-finite values and non-JSON parameters", () => {
    const request = generationRequest();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const parameters of [cycle, { huge: "x".repeat(65_537) }, { invalid: Number.NaN }, { callback() {} }, { date: new Date(NOW) }]) {
      expect(digestGenerationRequest({ request: { ...request, parameters } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });
  it("rejects invalid scope, stale/far deadlines and missing rights evidence", () => {
    const request = generationRequest();
    expect(parseGeneration({ context: { ...context, principal: { kind: "owner", ownerId: "other" } }, request, now: NOW })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(parseGeneration({ context, request, now: request.deadlineAt })).toMatchObject({ ok: false, error: { code: "expired" } });
    const distant = { ...request, deadlineAt: NOW + 86_400_001 };
    expect(parseGeneration({ context, request: { ...distant, argumentsDigest: value({ outcome: digestGenerationRequest({ request: distant }) }) }, now: NOW })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const noRights = { ...request, rightsEvidenceId: "" };
    expect(parseGeneration({ context, request: { ...noRights, argumentsDigest: value({ outcome: digestGenerationRequest({ request: noRights }) }) }, now: NOW })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("rejects quote argument/configuration drift and stale pricing", () => {
    const request = generationRequest();
    const quote = quoteFor({ request });
    expect(validateQuote({ request, quote: { ...quote, argumentsDigest: "c".repeat(64) }, now: NOW })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(validateQuote({ request, quote: { ...quote, modelConfigurationDigest: "c".repeat(64) }, now: NOW })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(validateQuote({ request, quote, now: quote.expiresAt })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(validateQuote({ request, quote: quoteFor({ request, unknown: true }), now: NOW })).toMatchObject({ ok: true, value: { status: "unknown", estimated: null } });
  });
});
