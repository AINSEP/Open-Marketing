import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { PluginSource, InstalledPlugin, UninstallReceipt, PluginExtensionDescriptor, PluginReference, PluginService } from "./types.js";
/** Scoped metadata. save/remove must be atomic; never share records across owner/workspace. */
export interface PluginRepoPort {
 get(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<InstalledPlugin | null>>;
 save(required: { context: CallContext; plugin: InstalledPlugin }, optional?: CallOptions): Promise<Outcome<InstalledPlugin>>;
 remove(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Server package effects. checkIdle blocks updates/removal while jobs are running.
 * install verifies pinned bytes and never enables tools. dispose is idempotent and may return pending.
 * Hosts exclude new dispatch between checkIdle and disposal using current admission state. */
export interface PluginLifecyclePort {
 install(required: { context: CallContext; source: PluginSource }, optional?: CallOptions): Promise<Outcome<InstalledPlugin>>;
 dispose(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<UninstallReceipt>>;
 checkIdle(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Validates bounded immutable source bytes with local format rules; never executes plugin code. */
export interface AgentPluginLayoutPort {
 validate(required: { source: PluginSource }, optional?: CallOptions): Promise<Outcome<PluginExtensionDescriptor>>;
}
/** Server-only admission. provision rechecks installed digest/schema and cannot grant writes/spend.
 * dispose unregisters bindings, invalidates authority, stops dispatch and disposes resources.
 * Both methods are idempotent and scoped; failures leave admission closed. */
export interface AgentPluginMcpProvisioningPort {
 provision(required: { context: CallContext; plugin: InstalledPlugin }, optional?: CallOptions): Promise<Outcome<void>>;
 dispose(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Verifies pinned bytes AND host trust, rather than accepting a plugin-supplied digest. */
export interface PluginTrustPort {
 verify(required: { source: PluginSource }, optional?: CallOptions): Promise<Outcome<PluginReference>>;
}
/** Append-only lifecycle audit; preserve context, never package text or credentials. */
export interface PluginAuditPort {
 record(required: { context: CallContext; pluginId: string; operation: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type PluginObserverPort = ObserverPort;
