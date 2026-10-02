import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import type { PluginSource, InstalledPlugin, UninstallReceipt, PluginExtensionDescriptor, PluginReference, PluginService } from "./types.js";
/** PluginRepoPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PluginRepoPort {
 get(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<InstalledPlugin | null>>;
 save(required: { context: CallContext; plugin: InstalledPlugin }, optional?: CallOptions): Promise<Outcome<InstalledPlugin>>;
}
/** PluginLifecyclePort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PluginLifecyclePort {
 install(required: { context: CallContext; source: PluginSource }, optional?: CallOptions): Promise<Outcome<InstalledPlugin>>;
 dispose(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<UninstallReceipt>>;
}
/** AgentPluginLayoutPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface AgentPluginLayoutPort {
 validate(required: { source: PluginSource }, optional?: CallOptions): Promise<Outcome<PluginExtensionDescriptor>>;
}
/** AgentPluginMcpProvisioningPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface AgentPluginMcpProvisioningPort {
 provision(required: { context: CallContext; plugin: InstalledPlugin }, optional?: CallOptions): Promise<Outcome<void>>;
 dispose(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
/** PluginTrustPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PluginTrustPort {
 verify(required: { source: PluginSource }, optional?: CallOptions): Promise<Outcome<PluginReference>>;
}
/** PluginAuditPort: caller-owned, injected boundary. j00 doubles fail explicitly until its owning job implements the suite. */
export interface PluginAuditPort {
 record(required: { context: CallContext; pluginId: string; operation: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
export type PluginObserverPort = ObserverPort;
