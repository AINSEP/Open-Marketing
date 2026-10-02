import { createHash } from "node:crypto";
import type { AppError, Outcome } from "@open-marketing/contracts";
import { failure, success } from "./outcomes.js";

type JsonState = { bytes: number; nodes: number; maxBytes: number; active: Set<object> };
class JsonBoundaryError extends Error {
  readonly code: AppError["code"];
  constructor(required: { code: AppError["code"] }) {
    super("JSON boundary rejected");
    this.code = required.code;
  }
}

/** Account before allocating; limits also bound schema compilation and canonical sorting. */
function account(required: { state: JsonState; bytes: number }): void {
  required.state.bytes += required.bytes;
  required.state.nodes += 1;
  if (required.state.bytes > required.state.maxBytes || required.state.nodes > 8192) {
    throw new JsonBoundaryError({ code: "limit_exceeded" });
  }
}

function copyString(required: { value: string; state: JsonState }): string {
  if (required.value.length > required.state.maxBytes) throw new JsonBoundaryError({ code: "limit_exceeded" });
  account({ state: required.state, bytes: Buffer.byteLength(JSON.stringify(required.value), "utf8") });
  return required.value;
}

/** JSON excludes accessors, class instances, sparse arrays and authority-shaped prototype keys. */
function entries(required: { value: object }): [string, PropertyDescriptor][] {
  const prototype = Object.getPrototypeOf(required.value);
  const allowed = Array.isArray(required.value) || prototype === Object.prototype || prototype === null;
  if (!allowed) throw new JsonBoundaryError({ code: "invalid_input" });
  const descriptors = Object.getOwnPropertyDescriptors(required.value);
  const keys = Object.keys(required.value).sort();
  return keys.map(key => [key, descriptors[key]]);
}

function propertyValue(required: { key: string; descriptor: PropertyDescriptor; state: JsonState }): unknown {
  if (["__proto__", "prototype", "constructor"].includes(required.key)) throw new JsonBoundaryError({ code: "invalid_input" });
  if (!("value" in required.descriptor)) throw new JsonBoundaryError({ code: "invalid_input" });
  copyString({ value: required.key, state: required.state });
  return required.descriptor.value;
}

function copyArray(required: { value: unknown[]; depth: number; state: JsonState }): readonly unknown[] {
  if (Object.keys(required.value).length !== required.value.length) throw new JsonBoundaryError({ code: "invalid_input" });
  const result = [];
  for (let index = 0; index < required.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(required.value, String(index));
    if (!descriptor) throw new JsonBoundaryError({ code: "invalid_input" });
    const value = propertyValue({ key: String(index), descriptor, state: required.state });
    result.push(copyJson({ value, depth: required.depth + 1, state: required.state }));
  }
  return Object.freeze(result);
}

function copyObject(required: { value: object; depth: number; state: JsonState }): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of entries({ value: required.value })) {
    const value = propertyValue({ key, descriptor, state: required.state });
    result[key] = copyJson({ value, depth: required.depth + 1, state: required.state });
  }
  return Object.freeze(result);
}

/** Bounded recursion; active-path tracking rejects cycles without rejecting repeated JSON values. */
function copyContainer(required: { value: object; depth: number; state: JsonState }): unknown {
  if (required.state.active.has(required.value)) throw new JsonBoundaryError({ code: "invalid_input" });
  required.state.active.add(required.value);
  let result: unknown;
  if (Array.isArray(required.value)) result = copyArray({ ...required, value: required.value });
  else result = copyObject(required);
  required.state.active.delete(required.value);
  return result;
}

function copyJson(required: { value: unknown; depth: number; state: JsonState }): unknown {
  if (required.depth > 16) throw new JsonBoundaryError({ code: "limit_exceeded" });
  const value = required.value;
  account({ state: required.state, bytes: 2 });
  if (typeof value === "string") return copyString({ value, state: required.state });
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    account({ state: required.state, bytes: String(value).length });
    return value;
  }
  if (typeof value === "object" && value !== null) return copyContainer({ ...required, value });
  throw new JsonBoundaryError({ code: "invalid_input" });
}

/**
 * Copy canonical JSON without executing user getters/toJSON; deeply freeze the independent result.
 * Returns invalid_input or limit_exceeded, never the tainted value in an error.
 * @complexity O(n log n) time for key sorting, O(n) space; n <=8192, depth <=16.
 * @example snapshotJson({ value: { query: "hello" }, maxBytes: 65536 })
 */
export function snapshotJson(required: { value: unknown; maxBytes: number }): Outcome<unknown> {
  try {
    const state: JsonState = { bytes: 0, nodes: 0, maxBytes: required.maxBytes, active: new Set() };
    const value = copyJson({ value: required.value, depth: 0, state });
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > required.maxBytes) return failure({ code: "limit_exceeded", message: "JSON size limit exceeded" });
    return success({ value });
  } catch (error) {
    if (error instanceof JsonBoundaryError) return failure({ code: error.code, message: "JSON boundary rejected" });
    return failure({ code: "invalid_input", message: "JSON boundary rejected" });
  }
}

/** SHA-256 of bounded canonical JSON, for cards/outbound identity. @complexity O(n). */
export function digestArguments(required: { arguments: Readonly<Record<string, unknown>> }): Outcome<string> {
  const snapshot = snapshotJson({ value: required.arguments, maxBytes: 65536 });
  if (!snapshot.ok) return snapshot;
  return success({ value: createHash("sha256").update(JSON.stringify(snapshot.value)).digest("hex") });
}
