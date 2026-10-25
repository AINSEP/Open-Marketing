import { expect, it } from "vitest";
import { createFederationHost, createMemoryFederationConnectionRepo, createMemoryFederationCredential,
  createMemoryFederatedCallConfirmation, createMemoryExternalMcpToolApprovalRepo, createMemoryFederatedDispatchGate,
  createMemoryFederationAudit, createMemoryToolRegistry, createMemoryMcpTransport, fingerprintSchemas } from "@open-marketing/federation";
import type { FederatedToolDescriptor, FederatedDispatchGatePort } from "@open-marketing/federation";
import { bindHiggsfieldEffect, createHiggsfieldQuote, higgsfieldToolName } from "../src/index.js";
import { fixture, pricing, submitData, value } from "./fixtures.js";
import { federationSuite } from "./contract/federation-suite.js";

/** Actual host composition with explicit test-only approvals/grants and opaque credential reference.
 * Transport is hand-written response data. No OAuth interaction, HTTP request or real money occurs.
 */
async function hostFixture(required: { admitted?: boolean } = {}): Promise<ReturnType<typeof fixture>> {
  const f = fixture();
  const d = f.dependencies;
  const inputSchema = { type: "object", required: ["params"], additionalProperties: false, properties: {
    params: { type: "object", required: ["model", "prompt", "count"], additionalProperties: false, properties: {
      model: { type: "string" }, prompt: { type: "string" }, count: { const: 1 }, aspect_ratio: { type: "string" }, seed: { type: "integer" },
    } },
  } };
  const fingerprint = value({ outcome: fingerprintSchemas({ inputSchema }) });
  const verifiedBinding = { ...d.binding, generationSchemaFingerprint: fingerprint };
  const evidence = { ...pricing, generationSchemaFingerprint: fingerprint };
  const quote = value({ outcome: createHiggsfieldQuote({ binding: verifiedBinding, intent: d.intent, pricing: evidence, now: d.clock.now({}), quoteId: "quote" }) });
  const toolName = higgsfieldToolName({ connectionId: verifiedBinding.connectionId, name: "generate_image" });
  const descriptor: FederatedToolDescriptor = { name: toolName, connectionId: verifiedBinding.connectionId, fingerprint, inputSchema,
    capability: { capabilityId: "image-generation.v1", version: 1, pluginId: "higgsfield-media", pluginDigest: verifiedBinding.pluginDigest,
      schemaFingerprint: fingerprint, admitted: required.admitted ?? true, effects: ["write", "generation"] } };
  const credentials = createMemoryFederationCredential({ entries: [{ connectionId: verifiedBinding.connectionId, credentialReference: "broker-reference" }] });
  const approvals = createMemoryExternalMcpToolApprovalRepo({});
  const gate = createMemoryFederatedDispatchGate({});
  const granted = new Set<string>();
  const dispatchGate: FederatedDispatchGatePort = {
    async authorize(input, options) {
      if (!granted.has(input.call.operationId)) {
        const grant = gate.grant({ grant: { ...input, permitId: "fixture-permit" } });
        if (!grant.ok) return grant;
        granted.add(input.call.operationId);
      }
      return gate.authorize(input, options);
    },
    dispatch: (input, options) => gate.dispatch(input, options),
  };
  const confirmation = createMemoryFederatedCallConfirmation({ approve: async input => {
    const approved = approvals.put({ approval: { approvalId: "fixture-owner-approval", ...input, argumentsDigest: input.call.argumentsDigest,
      expiresAt: d.clock.now({}) + 60000, revoked: false } });
    if (!approved.ok) return approved;
    return { ok: true, value: { approvalId: "fixture-owner-approval" } };
  } });
  const registry = createMemoryToolRegistry({});
  value({ outcome: await registry.register({ descriptor }) });
  const transport = createMemoryMcpTransport({ respond: async input => {
    f.calls.push({ context: input.context, call: input.call });
    return { ok: true, value: { operationId: input.call.operationId, status: "succeeded", content: [{ type: "json", data: submitData }] } };
  } });
  const host = createFederationHost({ connections: createMemoryFederationConnectionRepo({ entries: [{ connectionId: verifiedBinding.connectionId, scope: d.context.scope,
    pluginId: "higgsfield-media", pluginDigest: verifiedBinding.pluginDigest }] }), transport, credentials, confirmation, approvalRepo: approvals,
    dispatchGate, registry, audit: createMemoryFederationAudit({}), clock: d.clock,
    permissionGate: { async assess(input) { return bindHiggsfieldEffect({ binding: verifiedBinding, toolName: "generate_image", operationId: input.call.operationId,
      argumentsDigest: input.call.argumentsDigest, intentArgumentsDigest: d.intent.argumentsDigest, schemaFingerprint: input.call.schemaFingerprint, quote, now: d.clock.now({}) }); } },
  });
  return { ...f, dependencies: { ...d, binding: verifiedBinding, pricing: evidence, quote, federation: host }, revoke() { credentials.revoke({ connectionId: verifiedBinding.connectionId }); } };
}

federationSuite({ name: "federation port double", create: async () => fixture() });
federationSuite({ name: "actual federation host adapter", create: hostFixture });

it("actual federation host denies unadmitted generation without transport calls", async () => {
  const f = await hostFixture({ admitted: false });
  const d = f.dependencies;
  const args = { params: { model: d.intent.model, prompt: d.intent.prompt, count: 1 } };
  const argumentsDigest = value({ outcome: d.digest.digest({ arguments: args }) });
  const result = await d.federation.invoke({ context: d.context, call: {
    operationId: d.intent.operationId, connectionId: d.binding.connectionId,
    toolName: higgsfieldToolName({ connectionId: d.binding.connectionId, name: "generate_image" }),
    arguments: args, argumentsDigest, pluginDigest: d.binding.pluginDigest,
    schemaFingerprint: d.binding.generationSchemaFingerprint,
  } });
  expect(result).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
  expect(f.calls).toHaveLength(0);
});
