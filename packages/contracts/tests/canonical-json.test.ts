import { expect, it } from "vitest";
import { z } from "zod";
import { canonicalizeArguments } from "../src/index.js";
import type { Outcome } from "../src/index.js";

/** Frozen safety canonicalizer before extraction, independent of the shared implementation. */
function canonicalValue(required: { value: unknown; depth: number }): unknown {
 if (required.depth > 16) throw new Error("JSON depth exceeds 16");
 if (Array.isArray(required.value)) return required.value.map(value => canonicalValue({ value, depth: required.depth + 1 }));
 if (required.value === null || typeof required.value !== "object") return required.value;
 const record = required.value as Record<string, unknown>;
 return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue({ value: record[key], depth: required.depth + 1 })]));
}

/** Frozen old safety pipeline with hashing replaced by returning its canonical preimage. */
function legacyCanonicalizeArguments(required: { arguments: unknown }): Outcome<string> {
 try {
  const serialized = JSON.stringify(required.arguments);
  if (!serialized || serialized.length > 65_536) return { ok: false, error: { code: "invalid_input", message: "Arguments exceed JSON bounds", retryable: false } };
  const parsed = z.json().safeParse(required.arguments);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Arguments must be JSON", retryable: false } };
  const canonical = JSON.stringify(canonicalValue({ value: parsed.data, depth: 0 }));
  return { ok: true, value: canonical };
 } catch { return { ok: false, error: { code: "invalid_input", message: "Arguments exceed JSON bounds", retryable: false } }; }
}

/** Uses safety's boundary fixture pattern, counting nesting from a root at depth zero. */
function nestedArguments(required: { depth: number }): unknown {
 let value: unknown = "leaf";
 for (let depth = 0; depth < required.depth; depth++) value = { nested: value };
 return value;
}

const boundsFailure: Outcome<string> = { ok: false, error: { code: "invalid_input", message: "Arguments exceed JSON bounds", retryable: false } };
const jsonFailure: Outcome<string> = { ok: false, error: { code: "invalid_input", message: "Arguments must be JSON", retryable: false } };
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const vectors = [
 { name: "nested object keys", arguments: { b: 1, a: { d: [3, 1], c: null } }, expected: { ok: true, value: '{"a":{"c":null,"d":[3,1]},"b":1}' } },
 { name: "reordered nested object keys", arguments: { a: { c: null, d: [3, 1] }, b: 1 }, expected: { ok: true, value: '{"a":{"c":null,"d":[3,1]},"b":1}' } },
 { name: "array order", arguments: [2, 1], expected: { ok: true, value: "[2,1]" } },
 { name: "reversed array order", arguments: [1, 2], expected: { ok: true, value: "[1,2]" } },
 { name: "code-unit key sorting", arguments: { a: 1, "é": 3, Z: 2 }, expected: { ok: true, value: '{"Z":2,"a":1,"é":3}' } },
 { name: "empty object", arguments: {}, expected: { ok: true, value: "{}" } },
 { name: "empty array", arguments: [], expected: { ok: true, value: "[]" } },
 { name: "null", arguments: null, expected: { ok: true, value: "null" } },
 { name: "string", arguments: "x", expected: { ok: true, value: '"x"' } },
 { name: "65,536 serialized code units", arguments: "x".repeat(65_534), expected: { ok: true, value: '"' + "x".repeat(65_534) + '"' } },
 { name: "65,536 Unicode code units, not UTF-8 bytes", arguments: "é".repeat(65_534), expected: { ok: true, value: '"' + "é".repeat(65_534) + '"' } },
 { name: "65,537 serialized code units", arguments: "x".repeat(65_535), expected: boundsFailure },
 { name: "16 nested levels", arguments: nestedArguments({ depth: 16 }), expected: { ok: true, value: '{"nested":'.repeat(16) + '"leaf"' + "}".repeat(16) } },
 { name: "17 nested levels", arguments: nestedArguments({ depth: 17 }), expected: boundsFailure },
 { name: "undefined", arguments: undefined, expected: boundsFailure },
 { name: "cyclic object", arguments: cyclic, expected: boundsFailure },
 { name: "non-JSON NaN serialized as null", arguments: { a: NaN }, expected: jsonFailure },
] satisfies readonly { name: string; arguments: unknown; expected: Outcome<string> }[];

it.each(vectors)("returns the exact canonical string or failure for $name", vector => {
 expect(canonicalizeArguments({ arguments: vector.arguments })).toEqual(vector.expected);
});

it.each(vectors)("matches the old safety pipeline's full Outcome for $name", vector => {
 expect(canonicalizeArguments({ arguments: vector.arguments })).toEqual(legacyCanonicalizeArguments({ arguments: vector.arguments }));
});

it("ignores insertion order at every object level", () => {
 expect(canonicalizeArguments({ arguments: { b: 1, a: { d: [3, 1], c: null } } })).toEqual(
  canonicalizeArguments({ arguments: { a: { c: null, d: [3, 1] }, b: 1 } }),
 );
});
