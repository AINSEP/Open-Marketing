import type { CallContext, CredentialReference, KeyringConfiguration, Outcome } from "../index.js";
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const hostContext: CallContext = { ...context, principal: { kind: "service", serviceId: "server-egress" } };
export const reference: CredentialReference = { scope: context.scope, connectionId: "connection", version: 1 };
export const configuration: KeyringConfiguration = { hkdfSalt: "test-application-salt-v1", envVarName: "OM_CREDENTIAL_KEY", keyFilePath: "/test/key" };
export const clock = { now() { return 1234; } };
export const request = { pluginId: "plugin", returnUri: "https://studio.example/callback" };
export const storedSecret = { ciphertext: "opaque-test-ciphertext", version: 1, aadDigest: "0".repeat(64) };
/** Test assertion unwraps typed outcomes, failing before dependent assertions. @complexity O(1). */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(`Expected success, received ${required.outcome.error.code}`);
  return required.outcome.value;
}
