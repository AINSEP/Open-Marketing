import { createHash } from "node:crypto";
import { z } from "zod";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import type { CapabilityEnvelope, Outcome } from "@open-marketing/contracts";
import type { PluginExtensionDescriptor } from "./types.js";
import { OM_NAMESPACE, safePackagePath } from "./portable.js";
import { failure, success } from "./results.js";

const bindingSchema = z.strictObject({ server: z.string().min(1).max(256), binding: z.string().max(4096) });
const serverMetadata = z.strictObject({
  authMode: z.enum(["oauth", "none", "host"]).optional(),
  defaultTools: z.strictObject({ discover: z.array(z.string().max(256)).max(128) }).optional(),
  riskHints: z.record(z.string().max(256), z.array(z.enum(["read", "write", "spend", "destructive"])).max(10)).optional(),
});
const extensionSchema = z.strictObject({
  version: z.literal(1), enabled: z.boolean().optional(), admitted: z.boolean().optional(),
  servers: z.record(z.string().max(256), serverMetadata).optional(),
  capabilities: z.union([z.array(capabilityEnvelopeSchema).max(128), z.record(z.string().max(256), bindingSchema)]).optional(),
});

/** Namespace validation treats plugin hints as data, never authority. References resolve only inside
 * the namespace; bound declaration fingerprints come from bytes, not plugin claims.
 * @returns Empty descriptor when OM extension is absent, typed invalid_input otherwise.
 * @complexity O(n+b) time/space for bounded declarations and binding bytes.
 */
export function validateExtension(required: {
  value: unknown; pluginId: string; digest: string; files: ReadonlyMap<string, string>; servers: ReadonlySet<string>;
}): Outcome<PluginExtensionDescriptor> {
  const empty = { namespace: OM_NAMESPACE, version: 1 as const, capabilities: [] };
  if (required.value === undefined) return success({ value: empty });
  const parsed = extensionSchema.safeParse(required.value);
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid Open Marketing extension" });
  const declarations = parsed.data.capabilities ?? [];
  if (Object.keys(parsed.data.servers ?? {}).some(server => !required.servers.has(server))) {
    return failure({ code: "invalid_input", message: "Extension references an invalid or unknown server" });
  }
  if (Array.isArray(declarations)) return normalizeEnvelopes({ declarations, ...required });
  return resolveBindings({ declarations: declarations as Record<string, z.infer<typeof bindingSchema>>, ...required });
}

/** Duplicate/cross-plugin envelopes are rejected; admitted is always false. @complexity O(n). */
function normalizeEnvelopes(required: { declarations: readonly CapabilityEnvelope[]; pluginId: string; digest: string }): Outcome<PluginExtensionDescriptor> {
  const ids = new Set<string>();
  const capabilities: CapabilityEnvelope[] = [];
  for (const declaration of required.declarations) {
    if (ids.has(declaration.capabilityId) || declaration.pluginId !== required.pluginId || declaration.pluginDigest !== required.digest) {
      return failure({ code: "invalid_input", message: "Duplicate or mismatched capability identity" });
    }
    ids.add(declaration.capabilityId);
    capabilities.push({ ...declaration, admitted: false });
  }
  return success({ value: { namespace: OM_NAMESPACE, version: 1, capabilities } });
}

/** Binding schema only accepts a capability envelope; provider implementation remains server-owned. @complexity O(n+b). */
function resolveBindings(required: {
  declarations: Record<string, z.infer<typeof bindingSchema>>; pluginId: string; digest: string;
  files: ReadonlyMap<string, string>; servers: ReadonlySet<string>;
}): Outcome<PluginExtensionDescriptor> {
  const entries = Object.entries(required.declarations);
  if (entries.length > 128) return failure({ code: "limit_exceeded", message: "Too many capability bindings" });
  const capabilities: CapabilityEnvelope[] = [];
  for (const [capabilityId, binding] of entries) {
    const resolved = resolveOne({ capabilityId, binding, ...required });
    if (!resolved.ok) return resolved;
    capabilities.push(resolved.value);
  }
  return normalizeEnvelopes({ ...required, declarations: capabilities });
}

/** Fingerprints reflect the entire referenced declaration file. @complexity O(b) time/space. */
function resolveOne(required: {
  capabilityId: string; binding: z.infer<typeof bindingSchema>; pluginId: string; digest: string;
  files: ReadonlyMap<string, string>; servers: ReadonlySet<string>;
}): Outcome<CapabilityEnvelope> {
  const path = required.binding.binding.slice(2);
  if (!required.binding.binding.startsWith(`./${OM_NAMESPACE}/`) || !safePackagePath({ path }) || !required.servers.has(required.binding.server)) {
    return failure({ code: "invalid_input", message: "Unsafe or unresolved capability binding" });
  }
  const content = required.files.get(path);
  if (content === undefined) return failure({ code: "invalid_input", message: "Capability binding file is missing" });
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { return failure({ code: "invalid_input", message: "Capability binding is not JSON" }); }
  const parsed = capabilityEnvelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.capabilityId !== required.capabilityId) return failure({ code: "invalid_input", message: "Invalid capability binding envelope" });
  return success({ value: { ...parsed.data, schemaFingerprint: createHash("sha256").update(content).digest("hex"), admitted: false } });
}
