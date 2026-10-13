import { describe, expect, it } from "vitest";
import { createHiggsfieldRuntimeBinding } from "../../src/index.js";
import { renderContext, value } from "../fixtures.js";
import type { fixture } from "../fixtures.js";

/** SAME behavior suite for the port double and the actual federation host adapter. */
export function federationSuite(required: { name: string; create: () => Promise<ReturnType<typeof fixture>> }): void {
  describe(required.name, () => {
    it("forwards exact arguments and pins with trace IDs, without credentials", async () => {
      const f = await required.create();
      const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
      const wire = r.adapter.buildSubmitRequest({ ctx: renderContext });
      const response = await r.httpClient.send({ request: { method: "POST", url: wire.url, headers: {}, body: String(wire.init.body), timeoutMs: 15000 } });
      expect(response.status).toBe(200);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ context: { correlationId: "correlation", traceId: "trace", runId: "run" }, call: {
        operationId: "op", pluginDigest: f.dependencies.binding.pluginDigest, schemaFingerprint: f.dependencies.binding.generationSchemaFingerprint,
        arguments: JSON.parse(String(wire.init.body)).arguments,
      } });
      expect(JSON.stringify(f.calls)).not.toContain("broker-reference");
      expect(JSON.stringify(f.calls)).not.toContain("Bearer");
      expect(JSON.parse(response.bodyText).structuredContent.results[0].id).toBe("fixture-job");
    });
    it("revocation at the host denies egress, with no replay/fallback", async () => {
      const f = await required.create();
      const r = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
      f.revoke();
      const wire = r.adapter.buildSubmitRequest({ ctx: renderContext });
      await expect(r.httpClient.send({ request: { method: "POST", url: wire.url, headers: {}, body: String(wire.init.body), timeoutMs: 15000 } })).rejects.toMatchObject({ code: "forbidden" });
      expect(f.calls).toHaveLength(0);
    });
  });
}
