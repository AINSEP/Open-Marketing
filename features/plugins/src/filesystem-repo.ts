import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginRepoPort, PluginObserverPort } from "./ports.js";
import { attempt, failure, success } from "./results.js";
import { installedSchema, removeSchema } from "./schemas.js";
import { pluginScopeKey } from "./memory.js";

/** Host-managed atomic metadata files; keys are opaque scoped strings, never package paths.
 * The composition adapter maps keys to safe filenames and implements bounded reads/atomic rename.
 * @example createFilesystemPluginRepo({ files: scopedAtomicFiles })
 * @complexity O(b) work per bounded record, O(1) port calls; no in-process cache.
 */
export function createFilesystemPluginRepo(required: {
  files: {
    read(required: { key: string; maxBytes: number }, optional?: CallOptions): Promise<string | null>;
    writeAtomic(required: { key: string; content: string }, optional?: CallOptions): Promise<void>;
    remove(required: { key: string }, optional?: CallOptions): Promise<void>;
  };
}, optional: { observer?: PluginObserverPort } = {}): PluginRepoPort {
  /** File operations report trace IDs; failure messages contain no file contents. @complexity O(b). */
  async function io<T>(input: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
    const result = await attempt({ run: input.run });
    try { optional.observer?.observe({ operation: input.operation, outcome: result.ok ? "ok" : result.error.code,
      correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); }
    catch { /* Telemetry cannot change completed file effects. */ }
    return result;
  }
  return {
    async get(input, options) {
      const parsed = parseBoundary({ schema: removeSchema, input });
      if (!parsed.ok) return parsed;
      return io({ context: input.context, operation: "plugins.repo.get", run: async () => {
        const text = await required.files.read({ key: pluginScopeKey(input), maxBytes: 512 * 1024 }, options);
        if (text === null) return success({ value: null });
        if (Buffer.byteLength(text) > 512 * 1024) return failure({ code: "limit_exceeded", message: "Plugin metadata is oversized" });
        const plugin = parseBoundary({ schema: installedSchema, input: JSON.parse(text) });
        if (!plugin.ok) return plugin;
        if (plugin.value.pluginId !== input.pluginId) return failure({ code: "conflict", message: "Plugin metadata identity mismatch" });
        return plugin;
      } });
    },
    async save(input, options) {
      const parsed = parseBoundary({ schema: installedSchema, input: input.plugin });
      if (!parsed.ok) return parsed;
      const context = parseBoundary({ schema: removeSchema, input: { context: input.context, pluginId: parsed.value.pluginId } });
      if (!context.ok) return context;
      return io({ context: input.context, operation: "plugins.repo.save", run: async () => {
        await required.files.writeAtomic({ key: pluginScopeKey(context.value), content: JSON.stringify(parsed.value) }, options);
        return success({ value: parsed.value });
      } });
    },
    async remove(input, options) {
      const parsed = parseBoundary({ schema: removeSchema, input });
      if (!parsed.ok) return parsed;
      return io({ context: input.context, operation: "plugins.repo.remove", run: async () => {
        await required.files.remove({ key: pluginScopeKey(input) }, options);
        return success({ value: undefined });
      } });
    },
  };
}
