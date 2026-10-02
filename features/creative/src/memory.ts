import { notImplemented } from "@open-marketing/contracts";
import type { CreativeRepoPort, GenerationCapabilityPort, CreativeAssetPort, CreativeJobPort, CreativeSpendPort, CreativeAuditPort } from "./ports.js";
/** Stub double for CreativeRepoPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCreativeRepo(required: Record<string, never>): CreativeRepoPort { return {
 async save() { return notImplemented({ operation: "CreativeRepoPort.save" }); },
 async get() { return notImplemented({ operation: "CreativeRepoPort.get" }); },
 async appendCost() { return notImplemented({ operation: "CreativeRepoPort.appendCost" }); },
}; }
/** Stub double for GenerationCapabilityPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryGenerationCapability(required: Record<string, never>): GenerationCapabilityPort { return {
 async quote() { return notImplemented({ operation: "GenerationCapabilityPort.quote" }); },
 async generate() { return notImplemented({ operation: "GenerationCapabilityPort.generate" }); },
 async status() { return notImplemented({ operation: "GenerationCapabilityPort.status" }); },
 async pollDue() { return notImplemented({ operation: "GenerationCapabilityPort.pollDue" }); },
 async recover() { return notImplemented({ operation: "GenerationCapabilityPort.recover" }); },
 async cancel() { return notImplemented({ operation: "GenerationCapabilityPort.cancel" }); },
}; }
/** Stub double for CreativeAssetPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCreativeAsset(required: Record<string, never>): CreativeAssetPort { return {
 async import() { return notImplemented({ operation: "CreativeAssetPort.import" }); },
 async recordProvenance() { return notImplemented({ operation: "CreativeAssetPort.recordProvenance" }); },
 async recordCost() { return notImplemented({ operation: "CreativeAssetPort.recordCost" }); },
}; }
/** Stub double for CreativeJobPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCreativeJob(required: Record<string, never>): CreativeJobPort { return {
 async enqueue() { return notImplemented({ operation: "CreativeJobPort.enqueue" }); },
}; }
/** Stub double for CreativeSpendPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCreativeSpend(required: Record<string, never>): CreativeSpendPort { return {
 async assess() { return notImplemented({ operation: "CreativeSpendPort.assess" }); },
}; }
/** Stub double for CreativeAuditPort; B1 suite is shared with its future real adapter. No persistence claim. */
export function createMemoryCreativeAudit(required: Record<string, never>): CreativeAuditPort { return {
 async record() { return notImplemented({ operation: "CreativeAuditPort.record" }); },
}; }
