import type { CallContext, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import type { MetaCommand } from "./commands.js";

/** Host-owned trusted evidence, never supplied by an agent or portable manifest. */
export interface MetaEvidencePort {
  resolve(required: { context: CallContext; connectionId: string; accountId: string; operation: MetaCommand["kind"] }, optional?: CallOptions): Promise<Outcome<unknown>>;
}
/** Host's bounded local JSON-schema validator; no remote schema retrieval. */
export interface MetaSchemaPort {
  validate(required: { schema: Readonly<Record<string, unknown>>; value: unknown }): Outcome<void>;
}
/** Vendor call accepted by the trusted federation host; credentials never appear here. */
export interface MetaCall {
  readonly operationId: string; readonly connectionId: string; readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>; readonly argumentsDigest: string;
  readonly pluginDigest: string; readonly schemaFingerprint: string;
}
/** Gateway MUST recheck current evidence/account/mode/halt and exact authority at egress,
 * enforce timeout/buffers, consume ONE jobs outbox claim, and never retry uncertain writes.
 * The effect is trusted local metadata; remote annotations are not authority.
 */
export interface MetaGatewayPort {
  invoke(required: { context: CallContext; call: MetaCall; effect: EffectEnvelope; timeoutMs: number }, optional?: CallOptions): Promise<Outcome<unknown>>;
}
/** Structurally matches the public federation host. Composition adapts its trusted catalog/gates. */
export interface MetaFederationHostPort {
  invoke(required: { context: CallContext; call: MetaCall }, optional?: CallOptions): Promise<Outcome<unknown>>;
}
