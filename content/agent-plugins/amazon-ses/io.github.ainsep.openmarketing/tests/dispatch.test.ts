import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { createAmazonSesAdapter } from "../src/index.js";
import { account, configuration, credential, fixture, identity, invocation, unlimitedAccount } from "./fixtures.js";
import { sesHostContractSuite } from "./contract-suite.js";

sesHostContractSuite({ name: "SES memory broker/gateway", createHarness: fixture });
it("reports an unlimited daily quota explicitly without losing the rate or usage", async () => {
  const f = fixture({ response: () => Response.json(unlimitedAccount) });
  const result = await f.adapter.invoke(invocation);
  expect(result).toMatchObject({ ok: true, value: { data: { kind: "account_status",
    quota: { max24HourSend: -1, remaining24HourSend: "unlimited", maxSendRate: 1, sentLast24Hours: 12 } } } });
  expect(f.calls).toHaveLength(1);
});
it("clamps exhausted finite daily quota to zero", async () => {
  const f = fixture({ response: () => Response.json({ ...account, SendQuota: { ...account.SendQuota, SentLast24Hours: 201 } }) });
  expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: true, value: { data: { quota: { remaining24HourSend: 0 } } } });
});
it.each([-2, -0.5])("rejects undocumented negative daily quota %s", async max => {
  const f = fixture({ response: () => Response.json({ ...account, SendQuota: { ...account.SendQuota, Max24HourSend: max } }) });
  expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("signs the exact GET using injected time, SES scope and empty body", async () => {
  const f = fixture(); const result = await f.adapter.invoke(invocation);
  expect(result).toMatchObject({ ok: true, value: { data: { productionAccessEnabled: false, quota: { remaining24HourSend: 188 } } } });
  const call = f.calls[0]!; const headers = new Headers(call.init.headers);
  expect(call.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/account");
  expect(call.init).toMatchObject({ method: "GET", redirect: "error" }); expect(call.init.signal).toBeInstanceOf(AbortSignal);
  expect(headers.get("x-amz-date")).toBe("20261013T000000Z");
  const hash = createHash("sha256").update("").digest("hex");
  const canonical = ["GET", "/v2/email/account", "", `host:email.us-east-1.amazonaws.com\nx-amz-content-sha256:${hash}\nx-amz-date:20261013T000000Z\n`,
    "host;x-amz-content-sha256;x-amz-date", hash].join("\n");
  let key = Buffer.from("AWS4" + credential.secretAccessKey);
  for (const part of ["20261013", "us-east-1", "ses", "aws4_request"]) key = Buffer.from(createHmac("sha256", key).update(part).digest());
  const signing = "AWS4-HMAC-SHA256\n20261013T000000Z\n20261013/us-east-1/ses/aws4_request\n" + createHash("sha256").update(canonical).digest("hex");
  const signature = createHmac("sha256", key).update(signing).digest("hex");
  expect(headers.get("authorization")).toBe(`AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/20261013/us-east-1/ses/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`);
  expect(f.dispatches[0]!.effect.argumentsDigest).toBe(createHash("sha256").update(JSON.stringify(f.dispatches[0]!.request)).digest("hex"));
  expect(JSON.stringify([result, f.observations, f.dispatches])).not.toContain(credential.secretAccessKey);
  expect(f.observations[0]).toMatchObject({ correlationId: "correlation", traceId: "trace", runId: "run" });
});
it("reads only the configured domain and strips provider policies", async () => {
  const f = fixture({ response: () => Response.json({ ...identity, Policies: { secret: credential.secretAccessKey } }) });
  const result = await f.adapter.invoke({ ...invocation, command: { kind: "domain_identity_status" } });
  expect(f.calls[0]!.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/identities/example.com");
  expect(result).toMatchObject({ ok: true, value: { data: { domainReady: true, dkimTokens: ["synthetictoken"] } } });
  expect(JSON.stringify(result)).not.toContain("Policies");
});
it.each([undefined, { SigningEnabled: true, Status: "NEW_STATE" }, { SigningEnabled: false, Status: "SUCCESS" }])("fails closed on incomplete DKIM evidence %j", async dkim => {
  const f = fixture({ response: () => Response.json({ ...identity, DkimAttributes: dkim }) });
  expect(await f.adapter.invoke({ ...invocation, command: { kind: "domain_identity_status" } })).toMatchObject({ ok: true, value: { data: { domainReady: false } } });
});
it.each([{ kind: "send" }, { kind: "account_status", url: "https://evil.example" }, { kind: "domain_identity_status", domainIdentity: "evil.example" }])("rejects unsupported command fields %j without credentials/egress", async command => {
  const f = fixture(); expect((await f.adapter.invoke({ ...invocation, command } as never)).ok).toBe(false);
  expect(f.state.credentialCalls).toBe(0); expect(f.calls).toHaveLength(0);
});
it("denies cross-workspace reads, malformed region and wrong credential region", async () => {
  const f = fixture();
  expect((await f.adapter.invoke({ ...invocation, context: { ...invocation.context, scope: { ownerId: "other", workspaceId: "workspace" } } })).ok).toBe(false);
  const invalid = createAmazonSesAdapter({ ...f.dependencies, configuration: { ...configuration, region: "us-east-1.evil.example/" } });
  expect((await invalid.invoke(invocation)).ok).toBe(false);
  const mismatch = createAmazonSesAdapter({ ...f.dependencies, credentials: { async access() { return { ok: true, value: { ...credential, region: "us-west-2" } }; } } });
  expect(await mismatch.invoke(invocation)).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(0);
});
it("rejects cancellation before credentials and after broker resolution", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  expect(await f.adapter.invoke(invocation, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.state.credentialCalls).toBe(0);
  const later = new AbortController();
  const adapter = createAmazonSesAdapter({ ...f.dependencies, credentials: { async access() { later.abort(); return { ok: true, value: credential }; } } });
  expect(await adapter.invoke(invocation, { signal: later.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(f.calls).toHaveLength(0);
});
it.each([[403, "forbidden"], [429, "limit_exceeded"], [500, "unavailable"]])("maps HTTP %i without raw errors/retries", async (status, code) => {
  const f = fixture({ response: () => new Response(credential.secretAccessKey, { status: Number(status) }) });
  const result = await f.adapter.invoke(invocation); expect(result).toMatchObject({ ok: false, error: { code } });
  expect(f.calls).toHaveLength(1); expect(JSON.stringify([result, f.observations])).not.toContain(credential.secretAccessKey);
});
it.each(["not json", "{}", JSON.stringify({ ...account, SendQuota: { ...account.SendQuota, MaxSendRate: -1 } })])("rejects malformed provider success %s", async body => {
  const f = fixture({ response: () => new Response(body) }); expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("bounds streamed responses without trusting Content-Length", async () => {
  const f = fixture({ response: () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); controller.close();
  } }), { headers: { "content-length": "1" } }) });
  expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
});
it.each([true, false])("classifies midstream failure with caller cancellation %s", async cancel => {
  const controller = new AbortController(); let pulls = 0;
  const f = fixture({ response: () => new Response(new ReadableStream<Uint8Array>({ pull(stream) {
    if (pulls++ === 0) { stream.enqueue(new TextEncoder().encode('{"SendingEnabled":')); return; }
    if (cancel) controller.abort();
    stream.error(new Error(credential.secretAccessKey));
  } })) });
  const result = await f.adapter.invoke(invocation, { signal: controller.signal });
  expect(result).toMatchObject({ ok: false, error: { code: cancel ? "cancelled" : "protocol_mismatch" } });
  expect(pulls).toBe(2); expect(f.calls).toHaveLength(1);
  expect(f.observations[0]?.outcome).toBe(cancel ? "cancelled" : "protocol_mismatch");
  expect(JSON.stringify([result, f.observations])).not.toContain(credential.secretAccessKey);
});
it("prevents a gateway executing its callback twice", async () => {
  const f = fixture(); const adapter = createAmazonSesAdapter({ ...f.dependencies, gateway: { async dispatch(input) {
    await input.execute(); return input.execute();
  } } });
  expect(await adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
});
it("reports network failures, rejects invalid clocks and isolates observer failure", async () => {
  const f = fixture({ response: () => { throw new Error(credential.secretAccessKey); } });
  expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  f.state.time = NaN; expect(await f.adapter.invoke(invocation)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  const observer = fixture(); const adapter = createAmazonSesAdapter({ ...observer.dependencies, observer: { observe() { throw new Error("telemetry"); } } });
  expect((await adapter.invoke(invocation)).ok).toBe(true);
});
