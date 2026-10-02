import { createHash } from "node:crypto";
import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginLifecyclePort } from "./ports.js";
import type { InstalledPlugin, PluginSource } from "./types.js";
import { sourceSchema } from "./schemas.js";
import { failure, success } from "./results.js";

/** Structural subset of PUBLIC @jini-ai/agent-plugins/lifecycle exports. The composition root
 * injects createAgentPluginLifecycle's result; no sibling source dependency or copied algorithms.
 * Generic layout/reader types preserve the package's concrete public contracts.
 */
export type JiniPluginLifecycleApi<Layout, Reader> = {
  packAgentPluginDirectory(required: { sourceDir: string }): Promise<{ bytes: Uint8Array; sha256: string; files: readonly string[] }>;
  installAgentPlugin(required: { archive: Uint8Array; expectedSha256: string; archiveReader: Reader; layout: Layout; workspaceId: string }): Promise<{ pluginId: string; version?: string; archiveDigest: string }>;
  uninstallAgentPlugin(required: { layout: Layout; workspaceId: string; pluginId: string }): Promise<{ pluginId: string; removedDigests: readonly string[] }>;
};

/** Reuses Jini's published package packing, safe extraction, containment, and physical removal.
 * Requires a v1.1-capable release; the inspected local 0.3.0 lifecycle parser only accepts v1.0.
 * No compatibility rewrite changes pinned bytes. Unsupported input fails explicitly.
 * readArchive enforces maxBytes while reading; workspaceId maps BOTH owner and workspace to a
 * collision-free Jini workspace key. runningJobs is authoritative and checked again at disposal.
 * @example createJiniPluginLifecycleAdapter({ lifecycle, layout, archiveReader, readArchive, workspaceId, runningJobs })
 * @complexity Jini's bounded O(n+b) package work; O(1) host lookups. No local persistence/cache.
 */
export function createJiniPluginLifecycleAdapter<Layout, Reader>(required: {
  lifecycle: JiniPluginLifecycleApi<Layout, Reader>; layout: Layout; archiveReader: Reader;
  readArchive(required: { location: string; maxBytes: number }, optional?: CallOptions): Promise<Uint8Array>;
  workspaceId(required: { context: CallContext }): string;
  runningJobs(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<number>;
}): PluginLifecyclePort {
  /** Job activity is checked from the server, never inferred from process/session state. @complexity O(1). */
  async function checkIdle(input: { context: CallContext; pluginId: string }, options?: CallOptions): Promise<Outcome<void>> {
    try {
      const count = await required.runningJobs(input, options);
      if (!Number.isSafeInteger(count) || count < 0) return failure({ code: "unavailable", message: "Plugin job activity is invalid" });
      if (count > 0) return failure({ code: "conflict", message: "Running plugin jobs block update/removal" });
      return success({ value: undefined });
    } catch { return failure({ code: "unavailable", message: "Plugin job activity is unavailable" }); }
  }
  return {
    checkIdle,
    async install(input, options): Promise<Outcome<InstalledPlugin>> {
      const parsed = parseBoundary({ schema: sourceSchema, input: input.source });
      if (!parsed.ok) return parsed;
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin installation cancelled before effects" });
      try {
        const archive = await sourceBytes({ source: parsed.value, lifecycle: required.lifecycle, readArchive: required.readArchive }, options);
        if (!archive.ok) return archive;
        const installed = await required.lifecycle.installAgentPlugin({ archive: archive.value,
          expectedSha256: parsed.value.expectedDigest, archiveReader: required.archiveReader, layout: required.layout,
          workspaceId: required.workspaceId({ context: input.context }) });
        if (installed.archiveDigest !== parsed.value.expectedDigest) return failure({ code: "forbidden", message: "Jini installed digest mismatch" });
        return success({ value: { pluginId: installed.pluginId, version: installed.version ?? "", digest: installed.archiveDigest, enabled: false, admitted: false } });
      } catch (error) { return mapJiniFailure({ error }); }
    },
    async dispose(input, options) {
      const idle = await checkIdle(input, options);
      if (!idle.ok && idle.error.code === "conflict") return success({ value: { pluginId: input.pluginId, status: "pending" as const } });
      if (!idle.ok) return idle;
      try {
        await required.lifecycle.uninstallAgentPlugin({ layout: required.layout, workspaceId: required.workspaceId({ context: input.context }), pluginId: input.pluginId });
        return success({ value: { pluginId: input.pluginId, status: "removed" as const } });
      } catch (error) {
        if (isMissingPlugin({ error })) return success({ value: { pluginId: input.pluginId, status: "removed" as const } });
        return mapJiniFailure({ error });
      }
    },
  };
}

/** Copy pins a bounded archive against caller mutation; Jini handles extraction, not this adapter. @complexity O(b). */
async function sourceBytes<Layout, Reader>(required: {
  source: PluginSource; lifecycle: JiniPluginLifecycleApi<Layout, Reader>;
  readArchive(required: { location: string; maxBytes: number }, optional?: CallOptions): Promise<Uint8Array>;
}, options?: CallOptions): Promise<Outcome<Uint8Array>> {
  let bytes: Uint8Array;
  if (required.source.kind === "directory") {
    const packed = await required.lifecycle.packAgentPluginDirectory({ sourceDir: required.source.location });
    bytes = packed.bytes;
  } else bytes = await required.readArchive({ location: required.source.location, maxBytes: 32 * 1024 * 1024 }, options);
  if (bytes.byteLength > 32 * 1024 * 1024) return failure({ code: "limit_exceeded", message: "Plugin archive exceeds 32 MiB" });
  const pinned = Uint8Array.from(bytes);
  const digest = createHash("sha256").update(pinned).digest("hex");
  if (digest !== required.source.expectedDigest) return failure({ code: "forbidden", message: "Plugin bytes differ from expected digest" });
  return success({ value: pinned });
}

/** Jini's public missing-plugin exception supports idempotent removal only. @complexity O(1). */
function isMissingPlugin(required: { error: unknown }): boolean {
  return required.error instanceof Error && required.error.constructor.name === "AgentPluginNotFoundError";
}

/** Opaque upstream failures map to stable values without vendor messages. @complexity O(1). */
function mapJiniFailure(required: { error: unknown }): Outcome<never> {
  const code = (required.error as { code?: unknown } | null)?.code;
  if (code === "DIGEST_MISMATCH") return failure({ code: "forbidden", message: "Jini rejected plugin digest" });
  const invalid = new Set(["MANIFEST_MISSING", "MANIFEST_INVALID", "UNSAFE_ENTRY_PATH", "SYMLINK_ENTRY_REJECTED", "UNSUPPORTED_ENTRY_KIND", "DUPLICATE_ENTRY"]);
  if (typeof code === "string" && invalid.has(code)) return failure({ code: "invalid_input", message: "Jini rejected plugin layout/format" });
  const limits = new Set(["ARCHIVE_TOO_LARGE", "TOO_MANY_ENTRIES", "FILE_TOO_LARGE", "DECOMPRESSION_BOMB", "TOTAL_SIZE_EXCEEDED"]);
  if (typeof code === "string" && limits.has(code)) return failure({ code: "limit_exceeded", message: "Jini rejected plugin resource limit" });
  return failure({ code: "unavailable", message: "Jini lifecycle failed; reconcile before retry" });
}
