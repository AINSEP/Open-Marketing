import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
import { context, fixture } from "./fixtures.js";

it("accepts exact server configuration and exposes no unimplemented canonical handlers or I/O", () => {
  const f = fixture();
  const configuration = pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [] } });
  expect(createCapabilities({ ...f.dependencies, configuration, wait: async () => ({ ok: true, value: undefined }) })).toEqual({});
  expect(f.capabilities).toEqual({});
  expect(f.state.credentialCalls).toBe(0);
  expect(f.calls).toHaveLength(0);
});
it("does not advertise canonical metrics/status until they have executable implementations", () => {
  const plugin = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
  const rows = [...plugin.extensions["io.github.ainsep.openmarketing"].capabilities, ...metadata.capabilities];
  expect(rows.filter(row => ["report.metrics.v1", "campaign.status.v1"].includes(row.capabilityId))).toEqual([]);
});
