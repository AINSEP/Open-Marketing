import { describe, expect, it } from "vitest";
import { digestArguments } from "../index.js";
import { snapshotJson } from "../src/json.js";
import { validateApproval } from "../src/validation.js";
import { call, context } from "./fixtures/domain.js";

describe("Bounded canonical federation values", () => {
  it("hashes equivalent key orders identically and freezes independent values", () => {
    expect(digestArguments({ arguments: { z: 1, a: { y: 2, b: 3 } } })).toEqual(digestArguments({ arguments: { a: { b: 3, y: 2 }, z: 1 } }));
    const original = { nested: { query: "hello" } };
    const copied = snapshotJson({ value: original, maxBytes: 1024 });
    original.nested.query = "changed";
    expect(copied).toEqual({ ok: true, value: { nested: { query: "hello" } } });
    if (copied.ok) expect(Object.isFrozen((copied.value as typeof original).nested)).toBe(true);
  });

  it("never executes an argument accessor", () => {
    let reads = 0;
    const argumentsValue = Object.defineProperty({}, "query", { enumerable: true, get() { reads += 1; return "secret"; } });
    expect(digestArguments({ arguments: argumentsValue })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(reads).toBe(0);
  });

  it.each([undefined, NaN, Infinity, () => "unexpected", new Date(0)])("rejects non-JSON values", invalid => {
    expect(snapshotJson({ value: { invalid }, maxBytes: 1024 }).ok).toBe(false);
  });

  it("rejects cycles, sparse arrays and prototype keys", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(snapshotJson({ value: cycle, maxBytes: 1024 }).ok).toBe(false);
    expect(snapshotJson({ value: new Array(2), maxBytes: 1024 }).ok).toBe(false);
    expect(snapshotJson({ value: JSON.parse('{"__proto__":{"admin":true}}'), maxBytes: 1024 }).ok).toBe(false);
  });

  it("caps aggregate bytes, nodes and nesting", () => {
    expect(snapshotJson({ value: Array.from({ length: 8193 }, () => 1), maxBytes: 262144 })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(snapshotJson({ value: { query: "x".repeat(1025) }, maxBytes: 1024 })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    let nested: unknown = {};
    for (let index = 0; index < 18; index += 1) nested = { nested };
    expect(snapshotJson({ value: nested, maxBytes: 4096 })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("complete approval binding includes principal, operation, implementation, schema and exact arguments", () => {
    const invocation = { context, call: call({}) };
    const approval = { approvalId: "approval", ...invocation, argumentsDigest: invocation.call.argumentsDigest, expiresAt: 1000, revoked: false };
    const required = { approval, ...invocation, approvalId: "approval", now: 100 };
    expect(validateApproval(required).ok).toBe(true);
    expect(validateApproval({ ...required, context: { ...context, principal: { kind: "owner", ownerId: "other" } } }).ok).toBe(false);
    expect(validateApproval({ ...required, call: call({ operationId: "other" }) }).ok).toBe(false);
    expect(validateApproval({ ...required, call: { ...invocation.call, pluginDigest: "b".repeat(64) } }).ok).toBe(false);
    expect(validateApproval({ ...required, call: { ...invocation.call, schemaFingerprint: "b".repeat(64) } }).ok).toBe(false);
    expect(validateApproval({ ...required, call: call({ query: "changed" }) }).ok).toBe(false);
  });
});
