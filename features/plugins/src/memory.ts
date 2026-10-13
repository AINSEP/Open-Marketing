import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import type { PluginRepoPort, PluginLifecyclePort, AgentPluginLayoutPort, AgentPluginMcpProvisioningPort,
  PluginTrustPort, PluginAuditPort, PluginObserverPort } from "./ports.js";
import type { InstalledPlugin } from "./types.js";
import type { MemoryPluginPackage } from "./package-types.js";
import { inspectPluginPackage } from "./validation.js";
import { installedSchema, removeSchema, sourceSchema } from "./schemas.js";
import { failure, success } from "./results.js";

/** Collision-free scoped key shared by test adapters. @complexity O(n) for bounded IDs. */
export function pluginScopeKey(required: { context: CallContext; pluginId: string }): string {
  return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId, required.pluginId]);
}

/** In-memory metadata double, isolated and clone-on-read/write. @example createMemoryPluginRepo({})
 * @complexity O(1) lookup plus bounded metadata copies; O(n) storage.
 */
export function createMemoryPluginRepo(_required: Record<string, never>): PluginRepoPort {
  const records = new Map<string, InstalledPlugin>();
  return {
    async get(input) {
      const parsed = parseBoundary({ schema: removeSchema, input });
      if (!parsed.ok) return parsed;
      return success({ value: structuredClone(records.get(pluginScopeKey(parsed.value)) ?? null) });
    },
    async save(input) {
      const context = parseBoundary({ schema: removeSchema, input: { context: input.context, pluginId: input.plugin.pluginId } });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: installedSchema, input: input.plugin });
      if (!parsed.ok) return parsed;
      records.set(pluginScopeKey(context.value), structuredClone(parsed.value));
      return success({ value: structuredClone(parsed.value) });
    },
    async remove(input) {
      const parsed = parseBoundary({ schema: removeSchema, input });
      if (!parsed.ok) return parsed;
      records.delete(pluginScopeKey(parsed.value));
      return success({ value: undefined });
    },
  };
}

/** Fixture sources are explicit; an unconfigured double refuses installation/validation/trust.
 * @complexity O(n) source lookup, bounded by fixture count.
 */
function findPackage(required: { packages: readonly MemoryPluginPackage[]; source: MemoryPluginPackage["source"] }): Outcome<MemoryPluginPackage> {
  const parsed = parseBoundary({ schema: sourceSchema, input: required.source });
  if (!parsed.ok) return parsed;
  const fixture = required.packages.find(item => item.source.kind === parsed.value.kind && item.source.location === parsed.value.location);
  if (!fixture) return failure({ code: "unavailable", message: "Plugin source fixture is unavailable" });
  if (fixture.actualDigest !== parsed.value.expectedDigest) return failure({ code: "forbidden", message: "Plugin source digest mismatch" });
  return success({ value: fixture });
}

type MemoryLifecycle = PluginLifecyclePort & {
  setRunningJobs(required: { context: CallContext; pluginId: string; count: number }): void;
  installed(required: { context: CallContext; pluginId: string }): InstalledPlugin | null;
};
/** Package lifecycle double, with explicit running-job state and scoped disposal.
 * @example createMemoryPluginLifecycle({}, { packages: [fixture] })
 * @complexity O(n+b) installation, O(1) disposal; O(n) storage.
 */
export function createMemoryPluginLifecycle(_required: Record<string, never>, optional: { packages?: readonly MemoryPluginPackage[] } = {}): MemoryLifecycle {
  const packages = structuredClone(optional.packages ?? []);
  const installed = new Map<string, InstalledPlugin>();
  const jobs = new Map<string, number>();
  const port: MemoryLifecycle = {
    async install(input) {
      const found = findPackage({ packages, source: input.source });
      if (!found.ok) return found;
      const inspected = inspectPluginPackage({ package: found.value.package, digest: found.value.actualDigest });
      if (!inspected.ok) return inspected;
      const plugin = { pluginId: inspected.value.pluginId, version: inspected.value.version, digest: found.value.actualDigest, enabled: false, admitted: false };
      const idle = await port.checkIdle({ context: input.context, pluginId: plugin.pluginId });
      if (!idle.ok) return idle;
      installed.set(pluginScopeKey({ context: input.context, pluginId: plugin.pluginId }), plugin);
      return success({ value: structuredClone(plugin) });
    },
    async checkIdle(input) {
      if ((jobs.get(pluginScopeKey(input)) ?? 0) > 0) return failure({ code: "conflict", message: "Running plugin jobs must finish before update/removal" });
      return success({ value: undefined });
    },
    async dispose(input) {
      if ((jobs.get(pluginScopeKey(input)) ?? 0) > 0) return success({ value: { pluginId: input.pluginId, status: "pending" as const } });
      installed.delete(pluginScopeKey(input));
      return success({ value: { pluginId: input.pluginId, status: "removed" as const } });
    },
    setRunningJobs(input) { jobs.set(pluginScopeKey(input), input.count); },
    installed(input) { return structuredClone(installed.get(pluginScopeKey(input)) ?? null); },
  };
  return port;
}

/** Same portable inspector as filesystem/Jini sources; no permissive fixture shortcut.
 * @example createMemoryAgentPluginLayout({}, { packages: [fixture] })
 * @complexity O(n+b) bounded source/entry validation.
 */
export function createMemoryAgentPluginLayout(_required: Record<string, never>, optional: { packages?: readonly MemoryPluginPackage[] } = {}): AgentPluginLayoutPort {
  const packages = structuredClone(optional.packages ?? []);
  return { async validate(input) {
    const found = findPackage({ packages, source: input.source });
    if (!found.ok) return found;
    const inspected = inspectPluginPackage({ package: found.value.package, digest: found.value.actualDigest });
    if (!inspected.ok) return inspected;
    return success({ value: inspected.value.extension });
  } };
}

/** Trust double checks independent actual digest AND fixture host trust.
 * @example createMemoryPluginTrust({}, { packages: [fixture] })
 * @complexity O(n+b) bounded source validation.
 */
export function createMemoryPluginTrust(_required: Record<string, never>, optional: { packages?: readonly MemoryPluginPackage[] } = {}): PluginTrustPort {
  const packages = structuredClone(optional.packages ?? []);
  return { async verify(input) {
    const found = findPackage({ packages, source: input.source });
    if (!found.ok) return found;
    if (!found.value.trusted) return failure({ code: "forbidden", message: "Plugin has not been trusted by the host" });
    const inspected = inspectPluginPackage({ package: found.value.package, digest: found.value.actualDigest });
    if (!inspected.ok) return inspected;
    return success({ value: { pluginId: inspected.value.pluginId, digest: found.value.actualDigest } });
  } };
}

type MemoryProvisioning = AgentPluginMcpProvisioningPort & {
  bindings(required: Record<string, never>): readonly { readonly key: string; readonly plugin: InstalledPlugin }[];
  reset(required: Record<string, never>): void;
};
/** Admission registry double; registration is catalog-only. reset and disposal clear all bindings.
 * @example createMemoryAgentPluginMcpProvisioning({})
 * @complexity O(1) provision/dispose; O(n) inspection/reset and storage.
 */
export function createMemoryAgentPluginMcpProvisioning(_required: Record<string, never>): MemoryProvisioning {
  const bindings = new Map<string, InstalledPlugin>();
  return {
    async provision(input) {
      const parsed = parseBoundary({ schema: installedSchema, input: input.plugin });
      if (!parsed.ok) return parsed;
      if (!parsed.value.admitted || !parsed.value.schemaFingerprint) return failure({ code: "forbidden", message: "Plugin has no current schema admission" });
      bindings.set(pluginScopeKey({ context: input.context, pluginId: input.plugin.pluginId }), structuredClone(parsed.value));
      return success({ value: undefined });
    },
    async dispose(input) { bindings.delete(pluginScopeKey(input)); return success({ value: undefined }); },
    bindings() { return Array.from(bindings, ([key, plugin]) => ({ key, plugin: structuredClone(plugin) })); },
    reset() { bindings.clear(); },
  };
}

type AuditEntry = Parameters<PluginAuditPort["record"]>[0];
/** Append-only audit double; records clone all IDs and caller scope.
 * @example createMemoryPluginAudit({}).entries({})
 * @complexity O(1) append, O(n) inspection/storage.
 */
export function createMemoryPluginAudit(_required: Record<string, never>): PluginAuditPort & { entries(required: Record<string, never>): readonly AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    async record(input) { entries.push(structuredClone(input)); return success({ value: undefined }); },
    entries() { return structuredClone(entries); },
  };
}

/** Observer double closes the final owned port seam. @example createMemoryPluginObserver({})
 * @complexity O(1) append, O(n) inspection/storage.
 */
export function createMemoryPluginObserver(_required: Record<string, never>): PluginObserverPort & { events(required: Record<string, never>): readonly ObserverEvent[] } {
  const events: ObserverEvent[] = [];
  return { observe(input) { events.push(structuredClone(input)); }, events() { return structuredClone(events); } };
}
