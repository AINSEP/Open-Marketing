import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { createHiggsfieldQuote } from "../src/index.js";
import type { ChargeObservation, HiggsfieldDependencies, HiggsfieldFederationPort, HiggsfieldRenderContext as RenderContext, ImportReference, ImageIntent, PricingEvidence, VerifiedBinding } from "../src/index.js";

/** Synthetic fixtures only: account/job/model/CDN data do not name a live vendor account. */
export const NOW = 1791835200000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const binding: VerifiedBinding = {
  pluginId: "higgsfield-media", pluginDigest: "a".repeat(64), configurationDigest: "b".repeat(64),
  generationSchemaFingerprint: "c".repeat(64), statusSchemaFingerprint: "d".repeat(64),
  connectionId: "higgsfield", accountId: "synthetic-account", scope: context.scope,
  evidenceId: "fixture-admission", expiresAt: NOW + 120000,
};
export const intent: ImageIntent = { operationId: "op", argumentsDigest: "e".repeat(64), configurationDigest: binding.configurationDigest, prompt: "A red square", model: "fixture-image-v1", seed: 42, parameters: { count: 1, aspect_ratio: "1:1" } };
export const pricing: PricingEvidence = { evidenceId: "fixture-pricing", source: "hand-written fixture, not vendor pricing", observedAt: NOW - 1000, expiresAt: NOW + 90000,
  pluginDigest: binding.pluginDigest, configurationDigest: binding.configurationDigest, generationSchemaFingerprint: binding.generationSchemaFingerprint,
  accountId: binding.accountId, model: intent.model, argumentsDigest: intent.argumentsDigest, unitUpperBound: { minorUnits: 25, currency: "USD" }, creditRate: { minorUnits: 20, creditUnits: 1 } };
export const submitData = { results: [{ id: "fixture-job", type: "image", status: "pending" }], poll_after_seconds: 2 };
export const pendingData = { jobId: "fixture-job", status: "in_progress", poll_after_seconds: 2 };
export const completeData = { jobId: "fixture-job", status: "completed", resources: [{ type: "resource_link", uri: "https://cdn.example.test/image.png?signature=fixture", mimeType: "image/png" }],
  charge: { status: "charged", credits_exact: 1.25, evidence_id: "fixture-charge" } };
export const failedData = { jobId: "fixture-job", status: "failed", charge: { status: "charged", credits_exact: 1.25, evidence_id: "fixture-charge" } };
export const renderContext: RenderContext = { surface: "image", model: intent.model, wireModel: intent.model, prompt: intent.prompt, aspect: "1:1", length: undefined,
  duration: undefined, voice: "", audioKind: undefined, language: "", loop: false, promptInfluence: undefined, imageRef: null, imageRefs: [], requestInit: { dispatcher: undefined }, speechFormat: "mp3" };

/** Test assertions reject failed fixture setup; negatives cannot pass because of a broken setup. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  expect(required.outcome.ok).toBe(true);
  if (!required.outcome.ok) throw new Error("Fixture setup failed: " + required.outcome.error.code);
  return required.outcome.value;
}
/** Canonical fixture digest; production injects FederationHost's public digestArguments. */
function canonical(required: { input: unknown }): unknown {
  if (Array.isArray(required.input)) return required.input.map(input => canonical({ input }));
  if (required.input === null || typeof required.input !== "object") return required.input;
  return Object.fromEntries(Object.entries(required.input).sort(([a], [b]) => a.localeCompare(b)).map(([key, input]) => [key, canonical({ input })]));
}
/** Complete port harness with injection seams for adversarial/timeout/error cases. */
export function fixture(required: { evidence?: PricingEvidence | null; host?: HiggsfieldFederationPort } = {}) {
  let now = NOW;
  let next = 0;
  let revoked = false;
  let status: unknown = completeData;
  const calls: Parameters<HiggsfieldFederationPort["invoke"]>[0][] = [];
  const observations = new Map<string, ChargeObservation>();
  const references: ImportReference[] = [];
  const events: unknown[] = [];
  const d: HiggsfieldDependencies = {
    binding: structuredClone(binding), intent: structuredClone(intent), context: structuredClone(context), pricing: required.evidence === undefined ? structuredClone(pricing) : required.evidence,
    quote: value({ outcome: createHiggsfieldQuote({ binding, intent, pricing: required.evidence === undefined ? pricing : required.evidence, now, quoteId: "quote" }) }),
    clock: { now: () => now }, ids: { next: () => "status-" + (++next) },
    digest: { digest: input => ({ ok: true, value: createHash("sha256").update(JSON.stringify(canonical({ input: input.arguments }))).digest("hex") }) },
    federation: required.host ?? { async invoke(input) {
      if (revoked) return { ok: false, error: { code: "forbidden", message: "fixture revoked", retryable: false } };
      calls.push(structuredClone(input));
      return { ok: true, value: { operationId: input.call.operationId, status: "succeeded", content: [{ type: "json", data: input.call.toolName.endsWith("generate_image") ? submitData : status }] } };
    } },
    jobs: { async verify(input) {
      if (input.providerJobId !== "fixture-job" || input.operationId !== intent.operationId) return { ok: false, error: { code: "forbidden", message: "fixture job not owned", retryable: false } };
      return { ok: true, value: undefined };
    } },
    observations: { async append(input) {
      const previous = observations.get(input.observation.observationId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(input.observation)) return { ok: false, error: { code: "conflict", message: "fixture conflicting observation", retryable: false } };
      observations.set(input.observation.observationId, structuredClone(input.observation));
      return { ok: true, value: undefined };
    } },
    media: { async read(input) {
      references.push(structuredClone(input.reference));
      return { ok: true, value: { bytes: Buffer.from("fixture-png"), providerNote: "fixture", suggestedExt: "png" } };
    } },
    deadlines: { async run(input, optional) {
      if (optional?.signal?.aborted) return { ok: false, error: { code: "cancelled", message: "fixture cancelled", retryable: false } };
      return input.execute({ signal: new AbortController().signal });
    } },
    observer: { observe: input => { events.push(structuredClone(input)); } },
  };
  return { dependencies: d, calls, observations, references, events,
    setNow(input: { now: number }) { now = input.now; }, setStatus(input: { status: unknown }) { status = input.status; },
    revoke() { revoked = true; } };
}
