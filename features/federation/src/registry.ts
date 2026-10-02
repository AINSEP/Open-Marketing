import type { Outcome } from "@open-marketing/contracts";
import type { ToolRegistryPort } from "./ports.js";
import type { FederatedToolDescriptor } from "./types.js";
import { descriptorSchema, fingerprintSchemas, parseJson } from "./validation.js";
export { fingerprintSchemas } from "./validation.js";
import { failure, success } from "./outcomes.js";

/** Reject ambiguous namespace and schema fingerprints before mutating a catalog. */
function validateDescriptor(required: { descriptor: FederatedToolDescriptor }): Outcome<FederatedToolDescriptor> {
  const parsed = parseJson({ schema: descriptorSchema, input: required.descriptor, maxBytes: 65536 });
  if (!parsed.ok) return parsed;
  const descriptor = parsed.value;
  if (!descriptor.name.startsWith(`io.github.ainsep.openmarketing.${descriptor.connectionId}.`)) return failure({ code: "invalid_input", message: "Catalog namespace mismatch" });
  const fingerprint = fingerprintSchemas(descriptor);
  if (!fingerprint.ok) return fingerprint;
  if (descriptor.fingerprint !== fingerprint.value || descriptor.capability.schemaFingerprint !== fingerprint.value) return failure({ code: "invalid_input", message: "Catalog schema fingerprint mismatch" });
  return parsed;
}

/**
 * Instance-local trusted catalog. Register is insert-only (collisions never replace authority).
 * Reset removes entries but preserves usability; dispose is terminal. Invalidate affects one connection.
 * @example registry.register({ descriptor })
 * @complexity O(n log n) register/snapshot; O(t) invalidation, t<=1000; O(1) lookup.
 */
export function createMemoryToolRegistry(required: { maxEntries?: number }): ToolRegistryPort {
  const tools = new Map<string, FederatedToolDescriptor>();
  let disposed = false;
  function active(): Outcome<void> {
    if (disposed) return failure({ code: "unavailable", message: "Catalog disposed" });
    return success({ value: undefined });
  }
  return {
    async register(input) {
      const ready = active();
      if (!ready.ok) return ready;
      const descriptor = validateDescriptor(input);
      if (!descriptor.ok) return descriptor;
      if (tools.has(descriptor.value.name)) return failure({ code: "conflict", message: "Tool namespace collision" });
      if (tools.size >= (required.maxEntries ?? 1000)) return failure({ code: "limit_exceeded", message: "Catalog capacity exceeded" });
      tools.set(descriptor.value.name, descriptor.value);
      return success({ value: undefined });
    },
    async resolve(input) {
      const ready = active();
      if (!ready.ok) return ready;
      const descriptor = tools.get(input.name);
      if (!descriptor) return failure({ code: "forbidden", message: "Tool not in trusted catalog" });
      return parseJson({ schema: descriptorSchema, input: descriptor, maxBytes: 65536 });
    },
    async invalidate(input) {
      const ready = active();
      if (!ready.ok) return ready;
      for (const [name, descriptor] of tools) {
        if (descriptor.connectionId === input.connectionId) tools.delete(name);
      }
      return success({ value: undefined });
    },
    async unregister(input) {
      const ready = active();
      if (!ready.ok) return ready;
      tools.delete(input.name);
      return success({ value: undefined });
    },
    async reset() {
      const ready = active();
      if (!ready.ok) return ready;
      tools.clear();
      return success({ value: undefined });
    },
    async dispose() {
      tools.clear();
      disposed = true;
      return success({ value: undefined });
    },
  };
}
