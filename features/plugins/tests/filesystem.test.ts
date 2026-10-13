import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesystemAgentPluginLayout, createFilesystemPluginRepo } from "../index.js";
import { context, packageFixture, plugin, source } from "./fixtures/plugin.js";
import { atomicFiles, nativeFilesystem, temporaryDirectory, writePackage } from "./fixtures/filesystem.js";

describe("filesystem boundaries", () => {
  it("rejects symlink escapes before reading the target", async () => {
    const root = await temporaryDirectory({});
    const outside = await temporaryDirectory({});
    await writePackage({ root, package: packageFixture({}) });
    await writePackage({ root: outside, package: packageFixture({}) });
    await symlink(path.join(outside, "plugin.json"), path.join(root, "escaped"));
    const port = createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: root });
    expect(await port.validate({ source: { ...source, location: root } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects sibling-prefix and relative directory sources", async () => {
    const root = await temporaryDirectory({});
    const allowed = path.join(root, "allowed");
    const sibling = path.join(root, "allowed-sibling");
    await mkdir(allowed);
    await writePackage({ root: sibling, package: packageFixture({}) });
    const port = createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: allowed });
    expect(await port.validate({ source: { ...source, location: sibling } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await port.validate({ source: { ...source, location: "relative" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("an archive source with no reader fails explicitly", async () => {
    const root = await temporaryDirectory({});
    const port = createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: root });
    expect(await port.validate({ source: { ...source, kind: "archive" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("enforces directory nesting depth with actual files", async () => {
    const root = await temporaryDirectory({});
    await writePackage({ root, package: packageFixture({}) });
    await mkdir(path.join(root, ...Array.from({ length: 33 }, () => "deep")), { recursive: true });
    const port = createFilesystemAgentPluginLayout({ filesystem: nativeFilesystem({}), allowedRoot: root });
    expect(await port.validate({ source: { ...source, location: root } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("metadata survives a repository restart with trace context preserved", async () => {
    const files = atomicFiles({ root: await temporaryDirectory({}) });
    const events: unknown[] = [];
    const first = createFilesystemPluginRepo({ files }, { observer: { observe(input) { events.push(input); } } });
    expect(await first.save({ context, plugin })).toEqual({ ok: true, value: plugin });
    const second = createFilesystemPluginRepo({ files });
    expect(await second.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: plugin });
    expect(events).toEqual([{ operation: "plugins.repo.save", outcome: "ok", runId: context.runId, correlationId: context.correlationId, traceId: context.traceId }]);
  });

  it("does not accept corrupted or mismatched persisted identities", async () => {
    const files = {
      async read() { return JSON.stringify({ ...plugin, pluginId: "other" }); },
      async writeAtomic() {}, async remove() {},
    };
    const port = createFilesystemPluginRepo({ files });
    expect(await port.get({ context, pluginId: plugin.pluginId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const corrupt = createFilesystemPluginRepo({ files: { ...files, async read() { return "{credential secret"; } } });
    const result = await corrupt.get({ context, pluginId: plugin.pluginId });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("credential secret");
  });
});
