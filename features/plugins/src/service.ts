import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { PluginRepoPort, PluginLifecyclePort, AgentPluginLayoutPort, AgentPluginMcpProvisioningPort, PluginTrustPort, PluginAuditPort, PluginObserverPort } from "./ports.js";
import type { PluginSource, InstalledPlugin, UninstallReceipt, PluginExtensionDescriptor, PluginReference, PluginService } from "./types.js";
/** Inert plugins factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createPluginService({ injectedPorts: undefined } as Parameters<typeof createPluginService>[0]) @complexity O(1). */
export function createPluginService(
  required: {
    repo: PluginRepoPort;
    lifecycle: PluginLifecyclePort;
    layout: AgentPluginLayoutPort;
    provisioning: AgentPluginMcpProvisioningPort;
    trust: PluginTrustPort;
    audit: PluginAuditPort;
  },
  optional?: { observer?: PluginObserverPort },
): PluginService {
return {
 async install() { return notImplemented({ operation: "plugins.install" }); },
 async setEnabled() { return notImplemented({ operation: "plugins.setEnabled" }); },
 async uninstall() { return notImplemented({ operation: "plugins.uninstall" }); },
};
}
