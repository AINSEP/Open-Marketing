import { createCreativeService, createMemoryCreativeAsset, createMemoryCreativeAudit, createMemoryCreativeJob, createMemoryCreativeObserver, createMemoryCreativeRepo, createMemoryCreativeSpend, createMemoryGenerationCapability, digestGenerationRequest } from "../../index.js";
import type { CallContext, GenerationCostQuote, GenerationRequest, GenerationStatus, Outcome } from "../../index.js";
import type { CreativeRepoPort } from "../../src/ports.js";

export const NOW = 1_791_000_000_000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "service", serviceId: "creative-worker" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const otherContext: CallContext = { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } };
export const configurationDigest = "a".repeat(64);
/** Fixture uses the public digest convention, never invents a trusted fingerprint. */
export function generationRequest(required: { operationId?: string; prompt?: string; parameters?: Record<string, unknown> } = {}): GenerationRequest {
  const request = { capabilityId: "fixture-capability", operationId: required.operationId ?? "generation", configurationDigest,
    prompt: required.prompt ?? "Draw a campaign image", surface: "image" as const, model: "fixture-model", seed: 7,
    maxAttempts: 3, deadlineAt: NOW + 60_000, parameters: required.parameters ?? {}, rightsEvidenceId: "rights", vendorTermsDigest: null };
  return { ...request, argumentsDigest: value({ outcome: digestGenerationRequest({ request }) }) };
}
export function quoteFor(required: { request: GenerationRequest; unknown?: boolean }): GenerationCostQuote {
  return { quoteId: "quote", pluginId: "fixture-plugin", pluginDigest: "b".repeat(64), modelConfigurationDigest: configurationDigest,
    argumentsDigest: required.request.argumentsDigest, estimated: required.unknown ? null : { minorUnits: 100, currency: "USD" },
    upperBound: required.unknown ? null : { minorUnits: 150, currency: "USD" }, pricingEvidenceId: "pricing", expiresAt: NOW + 60_000, status: required.unknown ? "unknown" : "known" };
}
export function intentFor(required: { request?: GenerationRequest } = {}): GenerationStatus {
  const request = required.request ?? generationRequest();
  return { generationId: request.operationId, request, quote: quoteFor({ request }), approval: { kind: "normal_write", reason: "fixture", quoteId: "quote", allowanceRevision: 0, dispatchDay: "2026-10-02" },
    state: "pending", dispatchState: "queued", reservationId: null, asyncOperationId: null, revision: 0, operation: null, providerJobId: null, assetIds: [], actualCost: null, costs: [] };
}
/** Assertion helper fails loudly on unexpected outcomes; not a production error contract. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(required.outcome.error.code + ": " + required.outcome.error.message);
  return required.outcome.value;
}
export function serviceFixture(required: { repo?: CreativeRepoPort; kind?: "normal_write" | "exact_spend" | "denied"; dispatchAllowed?: boolean; unknownQuote?: boolean; rejectEnqueue?: boolean } = {}) {
  const repo = required.repo ?? createMemoryCreativeRepo({});
  const request = generationRequest();
  const quote = quoteFor({ request, unknown: required.unknownQuote });
  const generation = createMemoryGenerationCapability({ repo, quote });
  const assets = createMemoryCreativeAsset({});
  const jobs = createMemoryCreativeJob({ repo, reject: required.rejectEnqueue });
  const safety = createMemoryCreativeSpend({ kind: required.kind, dispatchAllowed: required.dispatchAllowed });
  const audit = createMemoryCreativeAudit({});
  const observer = createMemoryCreativeObserver({});
  let now = NOW;
  const clock = { now() { return now; } };
  const dependencies = { repo, generation, assets, jobs, safety, audit, clock, ids: { next() { return "id"; } } };
  const service = createCreativeService(dependencies, { observer });
  return { ...dependencies, service, request, quote, observer, setNow(input: { now: number }) { now = input.now; } };
}
export function completedStatus(required: { status: GenerationStatus; failed?: boolean; unknown?: boolean; minorUnits?: number }): GenerationStatus {
  const status = required.status;
  const id = status.asyncOperationId ?? "async-operation";
  return { ...status, state: required.unknown ? "unknown" : (required.failed ? "failed" : "succeeded"), dispatchState: "submitted", asyncOperationId: id,
    actualCost: required.minorUnits === undefined ? null : { minorUnits: required.minorUnits, currency: "USD" },
    operation: { schemaVersion: 1, id, providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: JSON.stringify([context.scope.ownerId, context.scope.workspaceId, status.generationId]),
      status: required.unknown ? "unknown" : (required.failed ? "failed" : "succeeded"), attempts: 1, maxAttempts: 3, deadlineAt: NOW + 60_000, nextPollAt: NOW, leaseOwner: null, leaseExpiresAt: null, state: { jobId: "vendor-job" },
      result: required.failed || required.unknown ? null : { bytesBase64: "aW1hZ2U=", providerNote: "fixture" }, error: null, createdAt: NOW, updatedAt: NOW }, providerJobId: "vendor-job" };
}
