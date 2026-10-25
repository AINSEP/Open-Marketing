import { describe, expect, it } from "vitest";
import { parseProviderJson, parseVendorStatus, parseVendorSubmission, pollDelay, validateImportUrl } from "../src/index.js";
import { completeData, failedData, pendingData, submitData, terminalReasons, value } from "./fixtures.js";

describe("Higgsfield handwritten historical-shape fixtures", () => {
  it.each(terminalReasons)("preserves %s separately from transport uncertainty and retains charge evidence", reason => {
    expect(parseVendorStatus({ input: { structuredContent: { ...failedData, status: reason, error: "private provider text" } }, jobId: "fixture-job", operationId: "op" }))
      .toEqual({ ok: true, value: { kind: "failed", reason, jobId: "fixture-job", credits: 1.25, chargeEvidenceId: "fixture-charge" } });
  });
  it.each(["canceled", "timed_out", "unknown", 1])("refuses unaccepted status schema drift %j", status => {
    expect(parseVendorStatus({ input: { structuredContent: { jobId: "fixture-job", status } }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: false });
  });
  it("rejects missing, duplicate and foreign-job completion results", () => {
    for (const resources of [[], [...completeData.resources, ...completeData.resources]]) {
      expect(parseVendorStatus({ input: { structuredContent: { ...completeData, resources } }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    }
    expect(parseVendorStatus({ input: { structuredContent: { ...completeData, jobId: "other" } }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("returns a pending job rather than claiming an imported asset", () => {
    expect(parseVendorSubmission({ input: { structuredContent: submitData } })).toEqual({ ok: true, value: { jobId: "fixture-job", retryAfterMs: 2000 } });
  });
  it("rejects plan-gated generation and multiple jobs without fallback or retry", () => {
    expect(parseVendorSubmission({ input: { isError: true, structuredContent: { monetization_intent: "upgrade" } } })).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    expect(parseVendorSubmission({ input: { structuredContent: { results: [...submitData.results, { ...submitData.results[0], id: "job2" }] } } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(parseVendorSubmission({ input: {} })).toMatchObject({ ok: false });
  });
  it("honors bounded polling intervals and rejects wrong-job/prose-only success", () => {
    expect(pollDelay({ seconds: 0 })).toBe(1000);
    expect(pollDelay({ seconds: 3600 })).toBe(60000);
    expect(pollDelay({})).toBe(5000);
    expect(pollDelay({ seconds: Number.NaN })).toBe(5000);
    expect(parseVendorStatus({ input: { structuredContent: pendingData }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: true, value: { kind: "pending", retryAfterMs: 2000 } });
    expect(parseVendorStatus({ input: { structuredContent: completeData }, jobId: "other-job", operationId: "op" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(parseVendorStatus({ input: { structuredContent: { status: "completed" }, content: [{ type: "text", text: "https://cdn.example.test/image.png" }] }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("produces an explicit import reference and preserves charged failures", () => {
    expect(value({ outcome: parseVendorStatus({ input: { structuredContent: completeData }, jobId: "fixture-job", operationId: "op" }) })).toMatchObject({ kind: "complete", reference: {
      provider: "higgsfield", providerJobId: "fixture-job", operationId: "op", mimeType: "image/png", sourceUrl: completeData.resources[0].uri,
    }, credits: 1.25, chargeEvidenceId: "fixture-charge" });
    expect(parseVendorStatus({ input: { structuredContent: failedData }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: true, value: { kind: "failed", credits: 1.25 } });
    expect(parseVendorStatus({ input: { structuredContent: { ...pendingData, cost: { credits_exact: 1.25 } } }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: true, value: { credits: null, chargeEvidenceId: null } });
  });
  it.each(["file:///secret", "http://cdn.example.test/a.png", "https://user:password@cdn.example.test/a.png", "https://cdn.example.test/a.png#token", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://localhost/a.png", "not-a-url"])("refuses unsafe import URL %s", url => {
    expect(validateImportUrl({ url })).toMatchObject({ ok: false });
  });
  it("bounds malformed JSON and invalid structured values", () => {
    expect(parseProviderJson({ text: "{" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(parseProviderJson({ text: "x".repeat(65537) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(validateImportUrl({ url: "https://cdn.example.test/" + "x".repeat(4096) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(parseVendorStatus({ input: { structuredContent: { status: "in_progress", poll_after_seconds: -1 } }, jobId: "fixture-job", operationId: "op" })).toMatchObject({ ok: false });
  });
});
