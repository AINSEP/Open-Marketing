import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Scope, Money, TimeWindow, Page, PageQuery, ConfirmationCard, EffectEnvelope, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, ServiceContext, MeasurementGrant, CapabilityEnvelope } from "@open-marketing/contracts";
import { notImplemented } from "@open-marketing/contracts";
import type { AuditRepoPort, AuditRedactorPort, AuditObserverPort } from "./ports.js";
import type { AuditEntry, AuditReceipt, AuditQuery, AuditPage, AuditService } from "./types.js";
/** Inert audit factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createAuditService({ injectedPorts: undefined } as Parameters<typeof createAuditService>[0]) @complexity O(1). */
export function createAuditService(
  required: {
    repo: AuditRepoPort;
    clock: ClockPort;
    ids: IdPort;
    redactor: AuditRedactorPort;
  },
  optional?: { observer?: AuditObserverPort },
): AuditService {
return {
 async record() { return notImplemented({ operation: "audit.record" }); },
 async list() { return notImplemented({ operation: "audit.list" }); },
};
}
