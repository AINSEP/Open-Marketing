import { describe, expect, it } from "vitest";
import { boundedJson, digest } from "../src/boundary.js";
import { verifyBinding } from "../src/evidence.js";
import { binding, now, pluginDigest, request } from "./fixtures.js";

describe("Meta boundary and evidence integrity", () => {
  it("canonical digests match object key reorder but preserve array order", () => {
    expect(digest({ value: { a: 1, Z: 2, $ref: "fixture", b: [1, 2] } })).toBe(digest({ value: { b: [1, 2], $ref: "fixture", Z: 2, a: 1 } }));
    expect(digest({ value: { ids: ["456", "457"] } })).not.toBe(digest({ value: { ids: ["457", "456"] } }));
  });
  it("rejects circular and oversized tainted objects", () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(boundedJson({ input: cyclic, maxBytes: 100 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(boundedJson({ input: "large", maxBytes: 2 })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it("rejects fabricated SDK-only primary evidence and future-dated captures", () => {
    const invocation = request();
    const captured = binding({ invocation });
    expect(verifyBinding({ input: { ...captured, primarySourceUrl: "https://github.com/facebook/facebook-python-business-sdk" }, request: invocation, claim: "paused-creation", pluginDigest, now }).ok).toBe(false);
    expect(verifyBinding({ input: { ...captured, verifiedAt: now + 1 }, request: invocation, claim: "paused-creation", pluginDigest, now }).ok).toBe(false);
  });
  it("requires an actual output schema and refuses a renamed tool outside the Meta namespace", () => {
    const invocation = request(); const captured = binding({ invocation });
    const { outputSchema: _schema, ...incomplete } = captured;
    expect(verifyBinding({ input: incomplete, request: invocation, claim: "paused-creation", pluginDigest, now }).ok).toBe(false);
    expect(verifyBinding({ input: { ...captured, toolName: "other-plugin.ads_create_campaign" }, request: invocation, claim: "paused-creation", pluginDigest, now }).ok).toBe(false);
  });
});
