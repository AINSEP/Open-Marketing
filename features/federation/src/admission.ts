import type { CallContext, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import type { FederationConnectionRepoPort, FederatedToolPermissionGate, ToolRegistryPort } from "./ports.js";
import type { ExternalToolCall, FederatedToolDescriptor, FederationConnection } from "./types.js";
import { boundary, failure, success } from "./outcomes.js";
import { connectionSchema, descriptorSchema, parseJson, sameScope, fingerprintSchemas, validateEffects, validateSchema } from "./validation.js";

/** Server catalog admission is independent of a vendor's advertised annotations. */
export type Admission = { readonly connection: FederationConnection; readonly descriptor: FederatedToolDescriptor; readonly effect: EffectEnvelope };
export type AdmissionDependencies = { connections: FederationConnectionRepoPort; registry: ToolRegistryPort; permissionGate: FederatedToolPermissionGate };

/** Check current namespace, implementation and admission binding. @complexity O(1). */
export function checkCatalogBinding(required: { context: CallContext; call: ExternalToolCall; connection: FederationConnection; descriptor: FederatedToolDescriptor }): Outcome<void> {
  const { call, connection, descriptor } = required;
  if (!sameScope({ context: required.context, connection })) return failure({ code: "forbidden", message: "Connection scope mismatch" });
  if (!catalogIdentityMatches(required)) return failure({ code: "forbidden", message: "Catalog binding changed" });
  const fingerprint = fingerprintSchemas(descriptor);
  if (!fingerprint.ok) return fingerprint;
  if (fingerprint.value !== call.schemaFingerprint) return failure({ code: "forbidden", message: "Tool schema changed" });
  if (!descriptor.capability.admitted || descriptor.capability.effects.length === 0) return failure({ code: "forbidden", message: "Tool not admitted" });
  if (!call.toolName.startsWith(`io.github.ainsep.openmarketing.${call.connectionId}.`)) return failure({ code: "forbidden", message: "Tool namespace mismatch" });
  return success({ value: undefined });
}

/** Match the current connection, implementation and admitted tool identity independently of schema hashing.
 * @complexity O(1); no I/O or caller mutation.
 */
function catalogIdentityMatches(required: { call: ExternalToolCall; connection: FederationConnection; descriptor: FederatedToolDescriptor }): boolean {
  const { call, connection, descriptor } = required;
  const pluginMatches = connection.pluginDigest === call.pluginDigest && descriptor.capability.pluginDigest === call.pluginDigest && descriptor.capability.pluginId === connection.pluginId;
  const schemaMatches = descriptor.fingerprint === call.schemaFingerprint && descriptor.capability.schemaFingerprint === call.schemaFingerprint;
  const toolMatches = descriptor.connectionId === call.connectionId && connection.connectionId === call.connectionId && descriptor.name === call.toolName;
  return pluginMatches && schemaMatches && toolMatches;
}

/** Re-read connection/catalog and assess safety every time; caller never supplies trusted effects. */
export async function admitCall(required: { dependencies: AdmissionDependencies; context: CallContext; call: ExternalToolCall }, optional?: CallOptions): Promise<Outcome<Admission>> {
  const connectionResult = await boundary({ perform: () => required.dependencies.connections.get({ context: required.context, connectionId: required.call.connectionId }, optional) });
  if (!connectionResult.ok) return connectionResult;
  const connection = parseJson({ schema: connectionSchema, input: connectionResult.value, maxBytes: 4096 });
  if (!connection.ok) return connection;
  const catalogResult = await boundary({ perform: () => required.dependencies.registry.resolve({ name: required.call.toolName }, optional) });
  if (!catalogResult.ok) return catalogResult;
  const descriptor = parseJson({ schema: descriptorSchema, input: catalogResult.value, maxBytes: 65536 });
  if (!descriptor.ok) return descriptor;
  return assessAdmitted({ ...required, connection: connection.value, descriptor: descriptor.value }, optional);
}

/** Keep schema decisions separate from the injected safety effect. */
async function assessAdmitted(required: { dependencies: AdmissionDependencies; context: CallContext; call: ExternalToolCall; connection: FederationConnection; descriptor: FederatedToolDescriptor }, optional?: CallOptions): Promise<Outcome<Admission>> {
  const bound = checkCatalogBinding(required);
  if (!bound.ok) return bound;
  const input = validateSchema({ schema: required.descriptor.inputSchema, value: required.call.arguments });
  if (!input.ok) return input;
  const assessed = await boundary({ perform: () => required.dependencies.permissionGate.assess({ context: required.context, call: required.call }, optional) });
  if (!assessed.ok) return assessed;
  const effect = validateEffects({ input: assessed.value, call: required.call, descriptor: required.descriptor });
  if (!effect.ok) return effect;
  return success({ value: { connection: required.connection, descriptor: required.descriptor, effect: effect.value } });
}

/** Only a nonempty trusted read-only effect set skips the exact card. */
export function isReadOnly(required: { admission: Admission }): boolean {
  return required.admission.effect.effects.every(effect => effect === "read");
}
