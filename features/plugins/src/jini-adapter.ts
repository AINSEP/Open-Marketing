import { createHash } from "node:crypto";
import { AgentPluginNotFoundError } from "@jini-ai/agent-plugins/lifecycle";
import type { createAgentPluginLifecycle, AgentPluginLayout, AgentPluginArchiveReaderPort } from "@jini-ai/agent-plugins/lifecycle";
import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginLifecyclePort } from "./ports.js";
import type { PluginObserverPort } from "./ports.js";
import type { InstalledPlugin, PluginSource } from "./types.js";
import { installedSchema, sourceSchema } from "./schemas.js";
import { failure, success } from "./results.js";

/** Exact subset of the published lifecycle facade. The composition root injects
 * createAgentPluginLifecycle's result; upstream API drift is a compile-time error.
 */
export type JiniPluginLifecycleApi = Pick<ReturnType<typeof createAgentPluginLifecycle>, "packAgentPluginDirectory" | "installAgentPlugin" | "uninstallAgentPlugin">;

/** Reuses Jini's published package packing, safe extraction, containment, and physical removal.
 * Requires a v1.1-capable release for OM installation; published 0.4.3 still accepts only v1.0.
 * No compatibility rewrite changes pinned bytes. Unsupported input fails explicitly.
 * readArchive enforces maxBytes while reading; workspaceId maps BOTH owner and workspace to a
 * collision-free lowercase Jini workspace key (e.g. SHA-256 of the full scope tuple).
 * runningJobs is authoritative and checked again at disposal.
 * @example createJiniPluginLifecycleAdapter({ lifecycle, layout, archiveReader, readArchive, workspaceId, runningJobs })
 * @complexity Jini's bounded O(n+b) package work; O(1) host lookups. No local persistence/cache.
 */
export function createJiniPluginLifecycleAdapter(required: {
  lifecycle: JiniPluginLifecycleApi; layout: AgentPluginLayout; archiveReader: AgentPluginArchiveReaderPort;
  readArchive(required: { location: string; maxBytes: number }, optional?: CallOptions): Promise<Uint8Array>;
  workspaceId(required: { context: CallContext }): string;
  runningJobs(required: { context: CallContext; pluginId: string }, optional?: CallOptions): Promise<number>;
}, optional: { observer?: PluginObserverPort } = {}): PluginLifecyclePort {
  /** Instrument external effects without allowing telemetry to change the lifecycle result. @complexity O(1). */
  async function observed<T>(input: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
    const result = await input.run();
    try {
      optional.observer?.observe({ operation: input.operation, outcome: result.ok ? "ok" : result.error.code,
        correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId });
    } catch { /* Telemetry never turns a completed package effect into a retry signal. */ }
    return result;
  }
  /** Job activity is checked from the server, never inferred from process/session state. @complexity O(1). */
  async function checkIdle(input: { context: CallContext; pluginId: string }, options?: CallOptions): Promise<Outcome<void>> {
    try {
      const count = await required.runningJobs(input, options);
      if (!Number.isSafeInteger(count) || count < 0) return failure({ code: "unavailable", message: "Plugin job activity is invalid" });
      if (count > 0) return failure({ code: "conflict", message: "Running plugin jobs block update/removal" });
      return success({ value: undefined });
    } catch { return failure({ code: "unavailable", message: "Plugin job activity is unavailable" }); }
  }
  const port: PluginLifecyclePort = {
    checkIdle,
    async install(input, options): Promise<Outcome<InstalledPlugin>> {
      const parsed = parseBoundary({ schema: sourceSchema, input: input.source });
      if (!parsed.ok) return parsed;
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin installation cancelled before effects" });
      try {
        const archive = await sourceBytes({ source: parsed.value, lifecycle: required.lifecycle, readArchive: required.readArchive }, options);
        if (!archive.ok) return archive;
        if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin installation cancelled before publication" });
        const installed = await required.lifecycle.installAgentPlugin({ archive: archive.value,
          expectedSha256: parsed.value.expectedDigest, archiveReader: required.archiveReader, layout: required.layout,
          workspaceId: required.workspaceId({ context: input.context }) });
        if (installed.archiveDigest !== parsed.value.expectedDigest) return failure({ code: "forbidden", message: "Jini installed digest mismatch" });
        return parseBoundary({ schema: installedSchema, input: { pluginId: installed.pluginId, version: installed.version ?? "", digest: installed.archiveDigest, enabled: false, admitted: false } });
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
  return {
    install(input, options) { return observed({ context: input.context, operation: "plugins.lifecycle.install", run: () => port.install(input, options) }); },
    dispose(input, options) { return observed({ context: input.context, operation: "plugins.lifecycle.dispose", run: () => port.dispose(input, options) }); },
    checkIdle(input, options) { return observed({ context: input.context, operation: "plugins.lifecycle.checkIdle", run: () => port.checkIdle(input, options) }); },
  };
}

/** Copy pins a bounded archive against caller mutation; Jini handles extraction, not this adapter. @complexity O(b). */
async function sourceBytes(required: {
  source: PluginSource; lifecycle: JiniPluginLifecycleApi;
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
  return required.error instanceof AgentPluginNotFoundError;
}

/** Opaque upstream failures map to stable values without vendor messages. @complexity O(1). */
function mapJiniFailure(required: { error: unknown }): Outcome<never> {
  const code = (required.error as { code?: unknown } | null)?.code;
  if (code === "DIGEST_MISMATCH") return failure({ code: "forbidden", message: "Jini rejected plugin digest" });
  if (code === "PLUGIN_ID_CONFLICT") return failure({ code: "conflict", message: "Jini rejected conflicting plugin identity" });
  const invalid = new Set(["MANIFEST_MISSING", "MANIFEST_INVALID", "UNSAFE_ENTRY_PATH", "SYMLINK_ENTRY_REJECTED", "UNSUPPORTED_ENTRY_KIND", "DUPLICATE_ENTRY"]);
  if (typeof code === "string" && invalid.has(code)) return failure({ code: "invalid_input", message: "Jini rejected plugin layout/format" });
  const limits = new Set(["ARCHIVE_TOO_LARGE", "TOO_MANY_ENTRIES", "FILE_TOO_LARGE", "DECOMPRESSION_BOMB", "TOTAL_SIZE_EXCEEDED"]);
  if (typeof code === "string" && limits.has(code)) return failure({ code: "limit_exceeded", message: "Jini rejected plugin resource limit" });
  return failure({ code: "unavailable", message: "Jini lifecycle failed; reconcile before retry" });
}
