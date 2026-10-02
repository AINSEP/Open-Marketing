import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
/** PluginSource domain value; validation belongs at the boundary. */
export type PluginSource = { readonly kind: "archive" | "directory"; readonly location: string; readonly expectedDigest: string };
/** InstalledPlugin domain value; validation belongs at the boundary. */
export type InstalledPlugin = { readonly pluginId: string; readonly version: string; readonly digest: string; readonly enabled: boolean; readonly admitted: boolean };
/** UninstallReceipt domain value; validation belongs at the boundary. */
export type UninstallReceipt = { readonly pluginId: string; readonly status: "pending" | "removed" };
/** PluginExtensionDescriptor domain value; validation belongs at the boundary. */
export type PluginExtensionDescriptor = { readonly namespace: "io.github.ainsep.openmarketing"; readonly version: 1; readonly capabilities: readonly CapabilityEnvelope[] };
/** PluginReference domain value; validation belongs at the boundary. */
export type PluginReference = { readonly pluginId: string; readonly digest: string };
export interface PluginService {
  install(
    required: { context: CallContext; source: PluginSource },
    optional?: CallOptions,
  ): Promise<Outcome<InstalledPlugin>>;

  setEnabled(
    required: { context: CallContext; pluginId: string; enabled: boolean },
    optional?: CallOptions,
  ): Promise<Outcome<InstalledPlugin>>;

  uninstall(
    required: { context: CallContext; pluginId: string },
    optional?: CallOptions,
  ): Promise<Outcome<UninstallReceipt>>;
}
