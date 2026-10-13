import * as filesystem from "node:fs/promises";
import path from "node:path";
import { createAgentPluginLayout, createAgentPluginLifecycle } from "@jini-ai/agent-plugins/lifecycle";
import type { PluginPackage } from "../../index.js";
import { packageFixture } from "./plugin.js";
import { temporaryDirectory, writePackage } from "./filesystem.js";

/** Test composition uses the published implementation with native temp files and deterministic
 * time/IDs. Network, tool provisioning and process execution are deliberately unavailable.
 */
export async function jiniFixture(required: { package?: PluginPackage } = {}) {
  const root = await temporaryDirectory({});
  const sourceDir = path.join(root, "source");
  await writePackage({ root: sourceDir, package: required.package ?? packageFixture({}, { manifest: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" } }) });
  const layout = createAgentPluginLayout({ root: path.join(root, "host") });
  let id = 0;
  let monotonic = 0;
  const lifecycle = createAgentPluginLifecycle({
    filesystem, layout, extensionNamespace: "io.github.ainsep.openmarketing", productName: "OM fixture",
    bundledArchiveMagic: "om-fixture-archive-v1", deliveryMode: "inject", seededEnabledPluginIds: new Set(), retiredBundledPlugins: new Map(),
    formatPluginToolPointer: input => `OM plugin ${input.pluginId}`,
    clock: { nowMs: () => 0, monotonicMs: () => monotonic, async sleep(input) { monotonic += input.ms; } },
    ids: { newId: () => `fixture-${++id}`, random: () => 0.5 },
    process: { pid: 1, platform: "darwin", hostname: () => "fixture", isAlive: () => false },
    mcpProvisioning: { async provision() {}, async setEnabled() {}, async remove() {}, async notifyRosterChanged() {} },
    async fetch() { throw new Error("No network in plugin fixtures"); },
    outboundGuard: { async assertAllowed() { throw new Error("No egress in plugin fixtures"); } },
  });
  const packed = await lifecycle.packAgentPluginDirectory({ sourceDir });
  const archiveReader = lifecycle.createBundledSourceArchiveReader({});
  return { root, layout, lifecycle, archiveReader, packed, source: { kind: "archive" as const, location: "/fixture/archive", expectedDigest: packed.sha256 } };
}
