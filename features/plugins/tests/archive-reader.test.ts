import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentPluginArchiveEntry, AgentPluginArchiveReaderPort } from "@jini-ai/agent-plugins/lifecycle";
import { createJiniArchivePackageReader, createJiniPluginLifecycleAdapter, inspectPluginPackage } from "../index.js";
import { context, packageFixture } from "./fixtures/plugin.js";
import { jiniFixture } from "./fixtures/jini.js";

const archive = new Uint8Array([1, 2, 3]);
const source = { kind: "archive" as const, location: "/fixture/archive", expectedDigest: createHash("sha256").update(archive).digest("hex") };

/** Scripted public reader seam for malicious metadata/streams; published codec stays real in the
 * separate packed-archive tests and B1 layout suite.
 */
function archiveFixture(required: { entries: readonly AgentPluginArchiveEntry[] }) {
  let opened = false;
  const archiveReader: AgentPluginArchiveReaderPort = { async *entries() { opened = true; yield* required.entries; } };
  const read = createJiniArchivePackageReader({ archiveReader, async readArchive() { return archive; } });
  return { read, opened: () => opened };
}

function fileEntry(required: { path: string; chunks: readonly Uint8Array[]; declaredSize?: number }): AgentPluginArchiveEntry {
  return { kind: "file", entryPath: required.path, declaredSize: required.declaredSize, async *openReadStream() { yield* required.chunks; } };
}

describe("Jini archive projection", () => {
  it("uses the published packing/streaming APIs to inspect v1.1 without extraction", async () => {
    const fixture = await jiniFixture({ package: packageFixture({}, { skills: true }) });
    const read = createJiniArchivePackageReader({ archiveReader: fixture.archiveReader, async readArchive() { return fixture.packed.bytes; } });
    const loaded = await read({ source: fixture.source });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("Expected readable archive");
    expect(inspectPluginPackage({ package: loaded.value, digest: fixture.packed.sha256 })).toMatchObject({ ok: true, value: { pluginId: "demo", agent: { skills: [{ name: "demo" }] } } });
  });

  it("published 0.4.3 lifecycle explicitly rejects v1.1 instead of pretending installation succeeded", async () => {
    const fixture = await jiniFixture({ package: packageFixture({}) });
    const port = createJiniPluginLifecycleAdapter({ lifecycle: fixture.lifecycle, layout: fixture.layout, archiveReader: fixture.archiveReader,
      async readArchive() { return fixture.packed.bytes; }, workspaceId: () => "fixture-workspace", async runningJobs() { return 0; } });
    expect(await port.install({ context, source: fixture.source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.lifecycle.listInstalledPlugins({ workspaceRoot: fixture.layout.forWorkspace({ workspaceId: "fixture-workspace" }).root })).toEqual([]);
  });

  it("pin mismatch and pre-cancellation never open the archive parser", async () => {
    const fixture = archiveFixture({ entries: [] });
    expect(await fixture.read({ source: { ...source, expectedDigest: "f".repeat(64) } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.opened()).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(await fixture.read({ source }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.opened()).toBe(false);
  });

  it.each([{ path: "../escape" }, { path: "/escape" }, { path: "%2e%2e/escape" }, { path: "C:\\escape" }])("rejects archive escape $path without opening its file stream", async ({ path }) => {
    let streamed = false;
    const fixture = archiveFixture({ entries: [{ kind: "file", entryPath: path, async *openReadStream() { streamed = true; yield new Uint8Array(); } }] });
    expect(await fixture.read({ source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(streamed).toBe(false);
  });

  it.each([{ kind: "symlink" as const }, { kind: "hardlink" as const }, { kind: "device" as const }, { kind: "fifo" as const }])("rejects archive $kind entries", async ({ kind }) => {
    const fixture = archiveFixture({ entries: [{ kind, entryPath: "link", linkTarget: "../escape" }] });
    expect(await fixture.read({ source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("normalizes directory suffixes before duplicate-path checks", async () => {
    const fixture = archiveFixture({ entries: [{ kind: "directory", entryPath: "same/" }, fileEntry({ path: "same", chunks: [] })] });
    expect(await fixture.read({ source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("counts observed expansion even when the declared file size lies", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const fixture = archiveFixture({ entries: [fileEntry({ path: "large", declaredSize: 1, chunks: Array.from({ length: 17 }, () => chunk) })] });
    expect(await fixture.read({ source })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("bounds the combined expansion of individually legal files", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 16 }, () => chunk);
    const entries = Array.from({ length: 5 }, (_, index) => fileEntry({ path: `file-${index}`, declaredSize: 1, chunks }));
    expect(await archiveFixture({ entries }).read({ source })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("bounds empty-chunk bookkeeping and archive entry count", async () => {
    const chunks = Array.from({ length: 65537 }, () => new Uint8Array());
    expect(await archiveFixture({ entries: [fileEntry({ path: "empty", chunks })] }).read({ source })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    const entries = Array.from({ length: 4097 }, (_, index) => ({ kind: "directory" as const, entryPath: `dir-${index}` }));
    expect(await archiveFixture({ entries }).read({ source })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("cancellation during a stream stops collection", async () => {
    const controller = new AbortController();
    const fixture = archiveFixture({ entries: [{ kind: "file", entryPath: "file", async *openReadStream() {
      controller.abort();
      yield new Uint8Array([1]);
    } }] });
    expect(await fixture.read({ source }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
