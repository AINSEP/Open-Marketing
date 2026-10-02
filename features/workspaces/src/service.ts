import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { WorkspaceRepoPort, IdentityPort, AccountBindingLookupPort, WorkspaceObserverPort } from "./ports.js";
import type { SessionReference, AccountBinding, VerifiedIdentity, WorkspaceService } from "./types.js";
/** Inert workspaces factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createWorkspaceService({ injectedPorts: undefined } as Parameters<typeof createWorkspaceService>[0]) @complexity O(1). */
export function createWorkspaceService(
  required: {
    repo: WorkspaceRepoPort;
    identity: IdentityPort;
    ids: IdPort;
    clock: ClockPort;
  },
  optional?: { observer?: WorkspaceObserverPort },
): WorkspaceService {
return {
 async resolveContext() { return notImplemented({ operation: "workspaces.resolveContext" }); },
 async bindAccount() { return notImplemented({ operation: "workspaces.bindAccount" }); },
};
}
