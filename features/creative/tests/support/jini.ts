import { createInMemoryAsyncOperationStore, startOperation, pollDueOperations, recoverAfterRestart } from "@jini-ai/integrations/media-providers";
import type { AsyncOperationStore, PollingVendorAdapter, StartOperationParams } from "@jini-ai/integrations/media-providers";
import { createJiniGenerationCapability, createMemoryCreativeRepo } from "../../index.js";
import type { CreativeRepoPort, JiniGenerationBinding, JiniGenerationHost, GenerationRequest } from "../../index.js";
import { evidenceId, failure, scopedKey, success } from "../../src/rules.js";
import { context, NOW, generationRequest, quoteFor } from "./fixtures.js";

/** Released runtime behind a synthetic plugin/transport. No vendor, network or real credentials. */
export function jiniFixture(required: { repo?: CreativeRepoPort; store?: AsyncOperationStore; request?: GenerationRequest; inline?: boolean; failSubmit?: boolean; failPoll?: boolean; idempotent?: boolean; missing?: boolean; actualCost?: number; noHttpClient?: boolean } = {}) {
  const repo = required.repo ?? createMemoryCreativeRepo({});
  const store = required.store ?? createInMemoryAsyncOperationStore();
  const request = required.request ?? generationRequest();
  let now = NOW;
  const calls: { method: string; url: string; body?: string }[] = [];
  const render: StartOperationParams<unknown>["ctx"] = { surface: request.surface, model: request.model, wireModel: request.model, prompt: request.prompt,
    aspect: undefined, length: undefined, duration: undefined, voice: "", audioKind: undefined, language: "", loop: false,
    promptInfluence: undefined, imageRef: null, imageRefs: [], requestInit: {}, speechFormat: "mp3" };
  const result = { bytes: Buffer.from("image"), providerNote: "fixture" };
  const adapter: PollingVendorAdapter<unknown> = {
    expectedLatencyClass: "fast", submitIsIdempotent: required.idempotent ?? false,
    buildSubmitRequest(input) { return { url: "https://fixture.invalid/generate", init: { method: "POST", body: JSON.stringify({ prompt: input.ctx.prompt, model: input.ctx.model }) }, meta: undefined }; },
    async parseSubmitResponse() { return required.inline ? { kind: "complete", result } : { kind: "pending", state: { jobId: "vendor-job" }, retryAfterMs: 0 }; },
    buildPollRequest(input) { return { url: "https://fixture.invalid/status/" + String(input.state.jobId), init: { method: "GET" }, meta: undefined }; },
    async parsePollResponse() { return required.failPoll ? { kind: "failed", message: "Vendor rejected render", code: "VENDOR_REJECTED" } : { kind: "complete", result }; },
  };
  const httpClient: JiniGenerationBinding["deps"]["httpClient"] = {
    async send(input) {
      calls.push({ method: input.request.method, url: input.request.url, ...(input.request.body === undefined ? {} : { body: input.request.body }) });
      if (required.failSubmit && input.request.method === "POST") throw new Error("submit timeout after possible charge");
      return { status: 200, headers: { "content-type": "application/json" }, bodyText: "{}", bodyBytes: new Uint8Array(Buffer.from("{}")), bodyBytesTruncated: false };
    },
  };
  const binding: JiniGenerationBinding = {
    pluginDigest: "b".repeat(64), configurationDigest: request.configurationDigest,
    deps: { store, httpClient, signer: input => ({ url: input.request.url, init: input.request.init }), persistRetryDelaysMs: [] },
    start: { adapter, ctx: render, providerId: "fixture-provider", routeKey: "fixture-route", graceMs: 0 },
    poll: { adapters() { return adapter; }, resolveContext() { return render; } },
    async awaitHandoff() { return calls.length === 0 ? failure({ code: "unavailable", message: "Fixture submit never reached transport" }) : success({ value: undefined }); },
  };
  const host: JiniGenerationHost = {
    async quote(input) { return required.missing ? failure({ code: "unavailable", message: "Connect or install a generation capability" }) : success({ value: quoteFor({ request: input.request }) }); },
    async resolve() {
      if (required.missing) return failure({ code: "unavailable", message: "Capability missing" });
      if (required.noHttpClient) return success({ value: { ...binding, deps: { ...binding.deps, httpClient: undefined } } as unknown as JiniGenerationBinding });
      return success({ value: binding });
    },
    async costs() { return success({ value: { actualCost: required.actualCost === undefined ? null : { minorUnits: required.actualCost, currency: "USD" }, costs: [] } }); },
  };
  const runtime = { startOperation, pollDueOperations, recoverAfterRestart };
  const clock = { now() { return now; } };
  const port = createJiniGenerationCapability({ runtime, host, repo, clock });
  const operationId = evidenceId({ generationId: scopedKey({ context, id: request.operationId }), kind: "async" });
  return { repo, store, port, runtime, host, clock, request, operationId, calls,
    async finish() { await port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } }); },
    setNow(input: { now: number }) { now = input.now; } };
}
