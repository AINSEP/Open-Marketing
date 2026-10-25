import { createHash } from "node:crypto";
import { PluginRepoPortSuite, AgentPluginLayoutPortSuite, PluginLifecyclePortSuite, AgentPluginMcpProvisioningPortSuite, PluginTrustPortSuite, PluginAuditPortSuite } from "./port-suites.js";
import { createFilesystemPluginRepo, createFilesystemAgentPluginLayout, createJiniPluginLifecycleAdapter, createJiniArchivePackageReader, createPluginMcpProvisioningAdapter, createPluginTrustAdapter, createPluginAuditAdapter } from "../../index.js";
import type { InstalledPlugin } from "../../index.js";
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
