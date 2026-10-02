import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { CreativeService } from "./types.js";
import { notImplemented } from "@open-marketing/contracts";
import type { CreativeRepoPort, GenerationCapabilityPort, CreativeAssetPort, CreativeJobPort, CreativeSpendPort, CreativeAuditPort, CreativeObserverPort } from "./ports.js";
/** Inert creative factory. @returns Service whose operations fail with typed not_implemented; no I/O or startup. @example createCreativeService({ injectedPorts: undefined } as Parameters<typeof createCreativeService>[0]) @complexity O(1). */
export function createCreativeService(
  required: {
    repo: CreativeRepoPort;
    generation: GenerationCapabilityPort;
    assets: CreativeAssetPort;
    jobs: CreativeJobPort;
    safety: CreativeSpendPort;
    clock: ClockPort;
    ids: IdPort;
    audit: CreativeAuditPort;
  },
  optional?: { observer?: CreativeObserverPort },
): CreativeService {
return {
 async requestGeneration() { return notImplemented({ operation: "creative.requestGeneration" }); },
 async refreshJob() { return notImplemented({ operation: "creative.refreshJob" }); },
 async pollDue() { return notImplemented({ operation: "creative.pollDue" }); },
 async recover() { return notImplemented({ operation: "creative.recover" }); },
 async cancelGeneration() { return notImplemented({ operation: "creative.cancelGeneration" }); },
};
}
