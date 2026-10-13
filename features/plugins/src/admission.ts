import { createHash } from "node:crypto";
import { z } from "zod";
import { capabilityEnvelopeSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { AgentPluginMcpProvisioningPort } from "./ports.js";
import type { InstalledPlugin, PluginExtensionDescriptor, PluginReference } from "./types.js";
import { attempt, failure, success } from "./results.js";

/** Closed local extension boundary; capability admission is host-owned. */
export const descriptorSchema = z.strictObject({ namespace: z.literal("io.github.ainsep.openmarketing"), version: z.literal(1), capabilities: z.array(capabilityEnvelopeSchema).max(128) })
  .refine(descriptor => new Set(descriptor.capabilities.map(capability => capability.capabilityId)).size === descriptor.capabilities.length);

/** Rejects declarations belonging to other installed bytes or plugins. No effects. @complexity O(n), n <=128. */
export function matchesPluginIdentity(required: { reference: PluginReference; descriptor: PluginExtensionDescriptor }): boolean {
  return required.descriptor.capabilities.every(capability => capability.pluginId === required.reference.pluginId && capability.pluginDigest === required.reference.digest);
}
/** Catalog schema pin ignores declaration ordering/admitted hints, includes effects/identity/schema.
 * @example pluginSchemaFingerprint({ descriptor })
 * @complexity O(n log n+b) time, O(n+b) space, n <=128.
 */
export function pluginSchemaFingerprint(required: { descriptor: PluginExtensionDescriptor }): string {
  const capabilities = required.descriptor.capabilities.map(capability => ({
    capabilityId: capability.capabilityId, version: capability.version, pluginId: capability.pluginId,
    pluginDigest: capability.pluginDigest, schemaFingerprint: capability.schemaFingerprint,
    effects: [...capability.effects].sort(),
  })).sort((left, right) => left.capabilityId < right.capabilityId ? -1 : Number(left.capabilityId > right.capabilityId));
  return createHash("sha256").update(JSON.stringify({ namespace: required.descriptor.namespace, version: required.descriptor.version, capabilities })).digest("hex");
}

/** Server capability admission with schema drift rejection and explicit revoke-before-dispose.
 * describe must verify pinned installed bytes and current tool schemas; register grants no execution.
 * The host supplies federation and safety callbacks in its composition root.
 * @example createPluginMcpProvisioningAdapter({ host: serverPluginHost })
 * @complexity O(n+b) schema validation, O(1) host calls, no private registry/cache.
 */
export function createPluginMcpProvisioningAdapter(required: {
  host: {
    describe(required: { context: CallContext; plugin: InstalledPlugin }, optional?: CallOptions): Promise<Outcome<PluginExtensionDescriptor>>;
    register(required: { context: CallContext; plugin: InstalledPlugin; descriptor: PluginExtensionDescriptor }, optional?: CallOptions): Promise<Outcome<void>>;
    invalidate(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
    dispose(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
  };
}): AgentPluginMcpProvisioningPort {
  return {
    async provision(input, options) {
      return attempt({ run: async () => {
        if (!input.plugin.admitted || !input.plugin.schemaFingerprint) return failure({ code: "forbidden", message: "Plugin has no current schema admission" });
        const described = await required.host.describe(input, options);
        if (!described.ok) return described;
        const parsed = parseBoundary({ schema: descriptorSchema, input: described.value });
        if (!parsed.ok) return parsed;
        const checked = checkAdmission({ plugin: input.plugin, descriptor: parsed.value });
        if (!checked.ok) return checked;
        return required.host.register({ ...input, descriptor: checked.value }, options);
      } });
    },
    async dispose(input, options) {
      return attempt({ run: async () => {
        const revoked = await required.host.invalidate(input, options);
        if (!revoked.ok) return revoked;
        return required.host.dispose(input, options);
      } });
    },
  };
}

/** Every capability is pinned to installed bytes; schema changes never reuse prior authority. @complexity O(n+b). */
function checkAdmission(required: { plugin: InstalledPlugin; descriptor: PluginExtensionDescriptor }): Outcome<PluginExtensionDescriptor> {
  const matches = matchesPluginIdentity({ reference: required.plugin, descriptor: required.descriptor });
  if (!matches || pluginSchemaFingerprint({ descriptor: required.descriptor }) !== required.plugin.schemaFingerprint) {
    return failure({ code: "forbidden", message: "Plugin digest or schema changed; reinstall and readmit" });
  }
  const capabilities = required.descriptor.capabilities.map(capability => ({ ...capability, admitted: false }));
  return success({ value: { ...required.descriptor, capabilities } });
}
