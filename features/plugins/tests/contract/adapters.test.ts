import { createHash } from "node:crypto";
import { createAgentPluginLayout } from "@jini-ai/agent-plugins/lifecycle";
import { PluginRepoPortSuite, AgentPluginLayoutPortSuite, PluginLifecyclePortSuite, AgentPluginMcpProvisioningPortSuite, PluginTrustPortSuite, PluginAuditPortSuite } from "./port-suites.js";
import { createFilesystemPluginRepo, createFilesystemAgentPluginLayout, createJiniPluginLifecycleAdapter, createJiniArchivePackageReader, createPluginMcpProvisioningAdapter, createPluginTrustAdapter, createPluginAuditAdapter } from "../../index.js";
import type { InstalledPlugin, JiniPluginLifecycleApi } from "../../index.js";
import { context, descriptor, digest, packageFixture, source } from "../fixtures/plugin.js";
import { atomicFiles, nativeFilesystem, temporaryDirectory, writePackage } from "../fixtures/filesystem.js";
import { failure } from "../../src/results.js";
import { jiniFixture } from "../fixtures/jini.js";

PluginRepoPortSuite({ create: async () => createFilesystemPluginRepo({ files: atomicFiles({ root: await temporaryDirectory({}) }) }) });
AgentPluginLayoutPortSuite({ create: async input => {
  const root = await temporaryDirectory({});
  await writePackage({ root, package: input.package ?? packageFixture({}) });
  return { port: createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: root }), source: { ...source, location: root } };
} });

AgentPluginLayoutPortSuite({ create: async input => {
  const fixture = await jiniFixture({ package: input.package ?? packageFixture({}) });
  const readArchive = createJiniArchivePackageReader({ archiveReader: fixture.archiveReader, async readArchive() { return fixture.packed.bytes; } });
  const port = createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: fixture.root, readArchive });
  return { port, source: fixture.source };
} });

/** Adapter contract fixture exercises the actual OM wrapper, without claiming Jini extraction proof. */
PluginLifecyclePortSuite({ create: () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const api: JiniPluginLifecycleApi = {
    async packAgentPluginDirectory() { return { bytes, sha256: digest, files: ["plugin.json"] }; },
    async installAgentPlugin(input) { return { pluginId: "demo", version: "1.2.3", archiveDigest: input.expectedSha256, packageRoot: "/fixtures/demo", files: ["plugin.json"], skills: [] }; },
    async uninstallAgentPlugin() { return { pluginId: "demo", removedDigests: [digest] }; },
  };
  const port = createJiniPluginLifecycleAdapter({ lifecycle: api, layout: createAgentPluginLayout({ root: "/fixtures" }), archiveReader: { async *entries() {} },
    async readArchive() { return bytes; }, workspaceId: input => createHash("sha256").update(JSON.stringify(input.context.scope)).digest("hex"), async runningJobs() { return 0; } });
  return { port, source: { ...source, expectedDigest: digest } };
} });

/** Published Jini + native temporary filesystem run the same lifecycle suite as the memory double.
 * v1.0 is used only to exercise the upstream implementation; OM v1.1 incompatibility is tested separately.
 */
PluginLifecyclePortSuite({ create: async () => {
  const fixture = await jiniFixture();
  const port = createJiniPluginLifecycleAdapter({ lifecycle: fixture.lifecycle, layout: fixture.layout, archiveReader: fixture.archiveReader,
    async readArchive() { return fixture.packed.bytes; }, workspaceId: input => createHash("sha256").update(JSON.stringify(input.context.scope)).digest("hex"), async runningJobs() { return 0; } });
  return { port, source: fixture.source };
} });

AgentPluginMcpProvisioningPortSuite({ create: () => {
  const bindings = new Map<string, InstalledPlugin>();
  const port = createPluginMcpProvisioningAdapter({ host: {
    async describe() { return { ok: true, value: descriptor }; },
    async register(input) { bindings.set(JSON.stringify(input.context.scope) + input.plugin.pluginId, structuredClone(input.plugin)); return { ok: true, value: undefined }; },
    async invalidate(input) { bindings.delete(JSON.stringify(input.context.scope) + input.pluginId); return { ok: true, value: undefined }; },
    async dispose() { return { ok: true, value: undefined }; },
  } });
  return { port, bindings: () => [...bindings.values()] };
} });

PluginTrustPortSuite({ create: () => ({ source, port: createPluginTrustAdapter({
  async inspectPinned(input) {
    if (input.source.expectedDigest !== digest) return failure({ code: "forbidden", message: "fixture byte mismatch" });
    return { ok: true, value: { pluginId: "demo", digest } };
  }, async isTrusted() { return { ok: true, value: undefined }; },
}) }) });

PluginAuditPortSuite({ create: () => {
  const entries: Parameters<ReturnType<typeof createPluginAuditAdapter>["record"]>[0][] = [];
  const port = createPluginAuditAdapter({ async append(input) { entries.push(structuredClone(input)); } });
  return { port, entries: () => entries };
} });
