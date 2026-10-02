import { describe, expect, it } from "vitest";
import type { McpTransportPort } from "../../index.js";
import { descriptor, harness } from "../fixtures/domain.js";
import type { TransportFixture } from "./port-suites.js";

type System = Awaited<ReturnType<typeof harness>>;
async function admissionCase(required: { create: () => Promise<TransportFixture>; effects?: readonly ("read" | "write")[]; assert: (required: { system: System; outboundCount: () => number }) => Promise<void> }): Promise<void> {
  const fixture = await required.create();
  let count = 0;
  const transport: McpTransportPort = { invoke: async (input, options) => { count += 1; return fixture.port.invoke(input, options); }, dispose: input => fixture.port.dispose(input) };
  try {
    const system = await harness({ transport, effects: required.effects });
    await required.assert({ system, outboundCount: () => count });
  } finally { await fixture.cleanup(); }
}

/** The SAME admission suite runs with memory and the real local HTTP/stdio transport adapters. */
export function FederationAdmissionSuite(required: { name: string; create: () => Promise<TransportFixture> }): void {
  describe(`Federation admission (${required.name})`, () => {
    it("runs admitted reads without a card and audits the authoritative result", async () => {
      await admissionCase({ create: required.create, assert: async ({ system, outboundCount }) => {
        const result = await system.host.invoke(system.invocation);
        expect(result.ok).toBe(true);
        expect(outboundCount()).toBe(1);
        expect(system.dependencies.confirmation.cards({})).toHaveLength(0);
        expect(system.dependencies.audit.entries({})).toEqual([
          { context: system.invocation.context, operationId: "operation", outcome: "dispatch_requested" },
          { context: system.invocation.context, operationId: "operation", outcome: "succeeded" },
        ]);
      } });
    });
    it("sends exactly the arguments displayed on the immutable write card", async () => {
      await admissionCase({ create: required.create, effects: ["write"], assert: async ({ system, outboundCount }) => {
        const result = await system.host.invoke(system.invocation);
        expect(result.ok).toBe(true);
        expect(outboundCount()).toBe(1);
        const card = system.dependencies.confirmation.cards({})[0];
        expect(card.call.arguments).toEqual(system.invocation.call.arguments);
        if (result.ok) {
          const text = result.value.content[0] as { type: string; text: string };
          const remote = JSON.parse(text.text);
          expect(remote.arguments).toEqual(card.call.arguments);
          expect(remote.metadata["io.github.ainsep.openmarketing"]).toMatchObject({ operationId: card.call.operationId, argumentsDigest: card.call.argumentsDigest, traceId: system.invocation.context.traceId, correlationId: system.invocation.context.correlationId, runId: system.invocation.context.runId });
          expect(result.value).not.toHaveProperty("_meta");
          expect(JSON.stringify(result.value)).not.toContain("vendorSecret");
          expect(JSON.stringify(result.value)).not.toContain("broker-reference");
        }
      } });
    });
    it("denies unknown tools despite syntactically valid names", async () => {
      await admissionCase({ create: required.create, assert: async ({ system, outboundCount }) => {
        const call = { ...system.invocation.call, toolName: "io.github.ainsep.openmarketing.fixture.unknown" };
        expect((await system.host.invoke({ ...system.invocation, call })).ok).toBe(false);
        expect(outboundCount()).toBe(0);
      } });
    });
    it("denies schema drift after confirmation", async () => {
      await admissionCase({ create: required.create, effects: ["write"], assert: async ({ system, outboundCount }) => {
        const confirm = system.dependencies.confirmation.confirm;
        system.dependencies.confirmation.confirm = async (input, options) => {
          const result = await confirm(input, options);
          await system.dependencies.registry.unregister({ name: system.tool.name });
          const next = descriptor({ effects: ["write"], inputSchema: { type: "object", additionalProperties: true } });
          await system.dependencies.registry.register({ descriptor: next });
          return result;
        };
        expect((await system.host.invoke(system.invocation)).ok).toBe(false);
        expect(outboundCount()).toBe(0);
      } });
    });
    it("denies approval revocation after confirmation", async () => {
      await admissionCase({ create: required.create, effects: ["write"], assert: async ({ system, outboundCount }) => {
        const confirm = system.dependencies.confirmation.confirm;
        system.dependencies.confirmation.confirm = async (input, options) => {
          const result = await confirm(input, options);
          system.dependencies.approvalRepo.revoke({ operationId: input.call.operationId });
          return result;
        };
        expect((await system.host.invoke(system.invocation)).ok).toBe(false);
        expect(outboundCount()).toBe(0);
      } });
    });
    it("denies credential revocation after confirmation", async () => {
      await admissionCase({ create: required.create, effects: ["write"], assert: async ({ system, outboundCount }) => {
        const confirm = system.dependencies.confirmation.confirm;
        system.dependencies.confirmation.confirm = async (input, options) => {
          const result = await confirm(input, options);
          system.dependencies.credentials.revoke({ connectionId: input.call.connectionId });
          return result;
        };
        expect((await system.host.invoke(system.invocation)).ok).toBe(false);
        expect(outboundCount()).toBe(0);
      } });
    });
    it("reload invalidates admission and fences pending confirmations", async () => {
      await admissionCase({ create: required.create, effects: ["write"], assert: async ({ system, outboundCount }) => {
        const confirm = system.dependencies.confirmation.confirm;
        system.dependencies.confirmation.confirm = async (input, options) => {
          const result = await confirm(input, options);
          expect(await system.host.reload({ context: input.context, connectionId: input.call.connectionId })).toEqual({ ok: true, value: { connectionId: "fixture", revision: 1 } });
          return result;
        };
        expect((await system.host.invoke(system.invocation)).ok).toBe(false);
        expect(outboundCount()).toBe(0);
        expect((await system.dependencies.registry.resolve({ name: system.tool.name })).ok).toBe(false);
      } });
    });
    it("concurrent operation replay causes at most one outbound call", async () => {
      await admissionCase({ create: required.create, assert: async ({ system, outboundCount }) => {
        const results = await Promise.all([system.host.invoke(system.invocation), system.host.invoke(system.invocation)]);
        expect(results.filter(result => result.ok)).toHaveLength(1);
        expect(outboundCount()).toBe(1);
      } });
    });
  });
}
