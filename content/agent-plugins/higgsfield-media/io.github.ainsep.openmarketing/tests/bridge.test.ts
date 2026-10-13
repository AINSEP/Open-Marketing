import { describe, expect, it } from "vitest";
import { createHiggsfieldRuntimeBinding, HiggsfieldBoundaryError } from "../src/index.js";
import { fixture, intent, renderContext, submitData, value } from "./fixtures.js";

describe("server-only Higgsfield bridge", () => {
  it("constructs inertly, copies caller intent and has no vendor credential/configuration seam", () => {
    const f = fixture();
    const mutable = { ...f.dependencies.intent };
    const runtime = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, intent: mutable } }) });
    mutable.prompt = "changed later";
    const request = runtime.adapter.buildSubmitRequest({ ctx: renderContext });
    expect(f.calls).toHaveLength(0);
    expect(request.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(request.init.body)).arguments.params.prompt).toBe(intent.prompt);
    expect(runtime.adapter.submitIsIdempotent).toBe(false);
  });
  it("rejects stale/forged/scope-drift inputs and unsupported generation flags", () => {
    const f = fixture();
    expect(createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, binding: { ...f.dependencies.binding, scope: { ownerId: "other", workspaceId: "workspace" } } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, quote: { ...f.dependencies.quote, estimated: { minorUnits: 0, currency: "USD" }, upperBound: { minorUnits: 0, currency: "USD" } } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, intent: { ...intent, parameters: { count: 2 } } } })).toMatchObject({ ok: false });
    const parameters = { count: 1, get_cost: true, use_unlim: true };
    expect(createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, intent: { ...intent, parameters } } })).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });
  it("refuses render drift, credential headers and arbitrary URLs before host invocation", async () => {
    const f = fixture();
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    expect(() => r.adapter.buildSubmitRequest({ ctx: { ...renderContext, model: "other" } })).toThrow(HiggsfieldBoundaryError);
    const request = { method: "POST" as const, url: "https://mcp.higgsfield.ai/mcp", headers: { authorization: "Bearer secret-fixture" }, body: "{}", timeoutMs: 15000 };
    await expect(r.httpClient.send({ request })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.httpClient.send({ request: { ...request, url: "https://other.example.test", headers: {} } })).rejects.toMatchObject({ code: "forbidden" });
    expect(f.calls).toHaveLength(0);
  });
  it("waits for bounded host handoff and does not launch generation twice", async () => {
    const result = Promise.withResolvers<Awaited<ReturnType<import("../src/index.js").HiggsfieldFederationPort["invoke"]>>>();
    let calls = 0;
    const f = fixture({ host: { async invoke() { calls += 1; return result.promise; } } });
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = r.adapter.buildSubmitRequest({ ctx: renderContext });
    const send = r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } });
    let handedOff = false;
    const handoff = r.awaitHandoff().then(outcome => { handedOff = true; return outcome; });
    await Promise.resolve();
    expect(handedOff).toBe(false);
    result.resolve({ ok: false, error: { code: "expired", message: "fixture timeout", retryable: false } });
    await expect(send).rejects.toMatchObject({ code: "expired" });
    expect(await handoff).toMatchObject({ ok: false, error: { code: "expired", retryable: false } });
    await expect(r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } })).rejects.toMatchObject({ code: "conflict" });
    expect(calls).toBe(1);
  });
  it("refuses aborted status, unknown foreign job and sync status inflation", async () => {
    const f = fixture();
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = { method: "POST" as const, url: "https://mcp.higgsfield.ai/mcp", headers: {}, timeoutMs: 15000,
      body: JSON.stringify({ name: "job_status", arguments: { jobId: "other-job" } }) };
    await expect(r.httpClient.send({ request })).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.httpClient.send({ request: { ...request, body: JSON.stringify({ name: "job_status", arguments: { jobId: "fixture-job", sync: true } }) } })).rejects.toMatchObject({ code: "invalid_input" });
    const controller = new AbortController(); controller.abort();
    await expect(r.httpClient.send({ request: { ...request, signal: controller.signal } })).rejects.toMatchObject({ code: "cancelled" });
    expect(f.calls).toHaveLength(0);
  });
  it("sanitizes thrown host errors", async () => {
    const f = fixture({ host: { async invoke() { throw new Error("secret-token-fixture"); } } });
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = r.adapter.buildSubmitRequest({ ctx: renderContext });
    const failed = r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } });
    await expect(failed).rejects.toMatchObject({ code: "unavailable", message: "Higgsfield boundary unavailable; reconcile possible charge" });
  });
  it.each([
    { operationId: "op", status: "unknown" as const, content: [] },
    { operationId: "wrong", status: "succeeded" as const, content: [] },
    { operationId: "op", status: "succeeded" as const, content: [] },
    { operationId: "op", status: "succeeded" as const, content: [{ type: "json", data: {} }, { type: "json", data: {} }] },
    { operationId: "op", status: "succeeded" as const, content: [{ type: "json", data: { results: [{ id: 42 }] } }] },
    { operationId: "op", status: "succeeded" as const, content: [{ type: "text", text: "not JSON" }] },
  ])("refuses malformed, ambiguous or unknown output without retry", async result => {
    const f = fixture({ host: { async invoke() { return { ok: true, value: result }; } } });
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = r.adapter.buildSubmitRequest({ ctx: renderContext });
    await expect(r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } })).rejects.toBeInstanceOf(HiggsfieldBoundaryError);
  });
  it("deadline denial prevents the callback from dispatching and returns a non-retryable handoff", async () => {
    const f = fixture();
    const deadlines: import("../src/index.js").HiggsfieldDeadlinePort = { async run() {
      return { ok: false, error: { code: "expired", message: "fixture deadline", retryable: false } };
    } };
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: { ...f.dependencies, deadlines } }) });
    const request = r.adapter.buildSubmitRequest({ ctx: renderContext });
    await expect(r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } })).rejects.toMatchObject({ code: "expired" });
    expect(await r.awaitHandoff()).toMatchObject({ ok: false, error: { code: "expired", retryable: false } });
    expect(f.calls).toHaveLength(0);
  });
  it("discards unrecognized provider credential fields before the durable parser sees a result", async () => {
    const f = fixture({ host: { async invoke(input) {
      return { ok: true, value: { operationId: input.call.operationId, status: "succeeded", content: [{ type: "json", data: { ...submitData, access_token: "secret-token-fixture", oauth: { refresh_token: "secret-refresh-fixture" } } }] } };
    } } });
    const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = r.adapter.buildSubmitRequest({ ctx: renderContext });
    const response = await r.httpClient.send({ request: { method: "POST", url: request.url, headers: {}, body: String(request.init.body), timeoutMs: 15000 } });
    expect(response.bodyText).not.toContain("secret");
    expect(response.bodyText).not.toContain("oauth");
    expect(JSON.parse(response.bodyText).structuredContent.results[0].id).toBe("fixture-job");
  });
});
