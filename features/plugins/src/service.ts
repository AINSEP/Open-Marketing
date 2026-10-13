import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginAuditPort, PluginLifecyclePort, PluginObserverPort, PluginRepoPort,
  AgentPluginLayoutPort, AgentPluginMcpProvisioningPort, PluginTrustPort } from "./ports.js";
import type { InstalledPlugin, PluginService, PluginSource, UninstallReceipt } from "./types.js";
import { descriptorSchema, matchesPluginIdentity, pluginSchemaFingerprint } from "./admission.js";
import { attempt, failure } from "./results.js";
import { enableSchema, installedSchema, installSchema, referenceSchema, removeSchema } from "./schemas.js";

type Dependencies = {
  repo: PluginRepoPort; lifecycle: PluginLifecyclePort; layout: AgentPluginLayoutPort;
  provisioning: AgentPluginMcpProvisioningPort; trust: PluginTrustPort; audit: PluginAuditPort;
};
type Invocation = { context: CallContext; pluginId: string };

/** Inert lifecycle orchestration. Install admits a catalog entry disabled; enable creates no grants.
 * Per-scope operations reject overlap, including update/enable races. Effects persist closed state
 * before cleanup; partial failures are explicit and leave the plugin disabled.
 * @example createPluginService({ repo, lifecycle, layout, provisioning, trust, audit })
 * @complexity O(1) service work/space per call, excluding bounded injected validation/adapters.
 * @tradeoffs One service instance per composition; durable cross-process locking belongs to adapters.
 */
export function createPluginService(required: Dependencies, optional: { observer?: PluginObserverPort } = {}): PluginService {
  const busy = new Set<string>();

  /** Trace-preserving boundary rejects overlapping scope operations. @complexity O(1). */
  async function invoke<T>(input: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }, options?: CallOptions): Promise<Outcome<T>> {
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Plugin operation cancelled before effects" });
    const key = JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId]);
    if (busy.has(key)) return failure({ code: "conflict", message: "A plugin lifecycle operation is already running in this scope" });
    busy.add(key);
    try {
      const result = await attempt({ run: input.run });
      observe({ context: input.context, operation: input.operation, result });
      return result;
    } finally { busy.delete(key); }
  }

  /** Telemetry cannot change an effect's result. @complexity O(1). */
  function observe(input: { context: CallContext; operation: string; result: Outcome<unknown> }): void {
    try {
      optional.observer?.observe({ operation: input.operation, outcome: input.result.ok ? "ok" : input.result.error.code,
        correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId });
    } catch { /* Observation failure cannot turn completed effects into a retry signal. */ }
  }

  /** Cleanup revokes resources even if metadata reads/writes fail. @complexity O(1). */
  async function close(input: Invocation, options?: CallOptions): Promise<Outcome<void>> {
    const metadata = await attempt({ run: () => closeMetadata(input, options) });
    const disposed = await attempt({ run: () => required.provisioning.dispose(input, options) });
    if (!disposed.ok) return disposed;
    return metadata;
  }

  /** Persist disabled/non-admitted state before unregistering. @complexity O(1). */
  async function closeMetadata(input: Invocation, options?: CallOptions): Promise<Outcome<void>> {
    const current = await required.repo.get({ context: input.context, pluginId: input.pluginId }, options);
    if (!current.ok) return current;
    if (!current.value) return { ok: true, value: undefined };
    const saved = await required.repo.save({ context: input.context, plugin: { ...current.value, enabled: false, admitted: false } }, options);
    if (!saved.ok) return saved;
    return { ok: true, value: undefined };
  }

  /** Update refuses busy jobs, invalidates old admission, then disposes. @complexity O(1). */
  async function retirePrevious(input: Invocation, options?: CallOptions): Promise<Outcome<void>> {
    const idle = await required.lifecycle.checkIdle(input, options);
    if (!idle.ok) return idle;
    const closed = await close(input, options);
    if (!closed.ok) return closed;
    const disposed = await required.lifecycle.dispose(input, options);
    if (!disposed.ok) return disposed;
    if (disposed.value.status === "pending") return failure({ code: "conflict", message: "Plugin disposal is pending; update refused" });
    return required.repo.remove(input, options);
  }

  /** Inspect/trust are separate injected boundaries; identities and schemas are locally parsed. @complexity O(n+b). */
  async function verifySource(input: { source: PluginSource }, options?: CallOptions): Promise<Outcome<{ pluginId: string; schemaFingerprint: string }>> {
    const layout = await required.layout.validate(input, options);
    if (!layout.ok) return layout;
    const descriptor = parseBoundary({ schema: descriptorSchema, input: layout.value });
    if (!descriptor.ok) return descriptor;
    const trusted = await required.trust.verify(input, options);
    if (!trusted.ok) return trusted;
    const reference = parseBoundary({ schema: referenceSchema, input: trusted.value });
    if (!reference.ok) return reference;
    if (reference.value.digest !== input.source.expectedDigest) return failure({ code: "forbidden", message: "Verified plugin digest differs from source pin" });
    if (!matchesPluginIdentity({ reference: reference.value, descriptor: descriptor.value })) return failure({ code: "forbidden", message: "Plugin declarations differ from verified identity" });
    return { ok: true, value: { pluginId: reference.value.pluginId, schemaFingerprint: pluginSchemaFingerprint({ descriptor: descriptor.value }) } };
  }

  /** Validate before replacing bytes; replay of an identical admitted install is idempotent. @complexity O(1) plus validation. */
  async function install(input: { context: CallContext; source: PluginSource }, options?: CallOptions): Promise<Outcome<InstalledPlugin>> {
    const verified = await verifySource({ source: input.source }, options);
    if (!verified.ok) return verified;
    const invocation = { context: input.context, pluginId: verified.value.pluginId };
    const previous = await required.repo.get(invocation, options);
    if (!previous.ok) return previous;
    if (sameAdmission({ plugin: previous.value, source: input.source, schemaFingerprint: verified.value.schemaFingerprint })) {
      return { ok: true, value: previous.value! };
    }
    const audited = await required.audit.record({ ...invocation, operation: "install.requested" }, options);
    if (!audited.ok) return audited;
    if (previous.value) {
      const retired = await retirePrevious(invocation, options);
      if (!retired.ok) return retired;
    }
    return installVerified({ ...input, ...verified.value }, options);
  }

  /** All three pins must match before replay can preserve current state. @complexity O(1). */
  function sameAdmission(input: { plugin: InstalledPlugin | null; source: PluginSource; schemaFingerprint: string }): boolean {
    if (!input.plugin?.admitted) return false;
    return input.plugin.digest === input.source.expectedDigest && input.plugin.schemaFingerprint === input.schemaFingerprint;
  }

  /** After audited intent, installs start disabled regardless of adapter claims. @complexity O(1). */
  async function installVerified(input: { context: CallContext; source: PluginSource; pluginId: string; schemaFingerprint: string }, options?: CallOptions): Promise<Outcome<InstalledPlugin>> {
    const result = await required.lifecycle.install({ context: input.context, source: input.source }, options);
    if (!result.ok) return result;
    const parsed = parseBoundary({ schema: installedSchema, input: result.value });
    if (!parsed.ok) return parsed;
    if (parsed.value.digest !== input.source.expectedDigest || parsed.value.pluginId !== input.pluginId) {
      return failure({ code: "forbidden", message: "Installed identity differs from verified identity" });
    }
    const plugin = { ...parsed.value, enabled: false, admitted: true, schemaFingerprint: input.schemaFingerprint };
    const saved = await required.repo.save({ context: input.context, plugin }, options);
    if (!saved.ok) return saved;
    const completed = await required.audit.record({ context: input.context, pluginId: input.pluginId, operation: "install.completed" }, options);
    if (!completed.ok) return completed;
    return saved;
  }

  /** Provisioning rechecks bytes/schema; disabling persists closed state before cleanup. @complexity O(1). */
  async function setEnabled(input: Invocation & { enabled: boolean }, options?: CallOptions): Promise<Outcome<InstalledPlugin>> {
    const current = await required.repo.get({ context: input.context, pluginId: input.pluginId }, options);
    if (!current.ok) return current;
    if (!current.value) return failure({ code: "invalid_input", message: "Plugin is not installed" });
    if (input.enabled && !current.value.admitted) return failure({ code: "forbidden", message: "Plugin must be reinstalled and verified before enabling" });
    const audited = await required.audit.record({ context: input.context, pluginId: input.pluginId, operation: input.enabled ? "enable.requested" : "disable.requested" }, options);
    if (!audited.ok) return audited;
    if (input.enabled) return enableAdmitted({ ...input, plugin: current.value }, options);
    return disableCurrent({ ...input, plugin: current.value }, options);
  }

  /** Always unregister on disable; failed persistence must not preserve runtime dispatch.
   * Returns the cleanup failure first, otherwise the metadata outcome. @complexity O(1).
   */
  async function disableCurrent(input: Invocation & { plugin: InstalledPlugin }, options?: CallOptions): Promise<Outcome<InstalledPlugin>> {
    const disabled = await attempt({ run: () => required.repo.save({ context: input.context, plugin: { ...input.plugin, enabled: false } }, options) });
    const disposed = await attempt({ run: () => required.provisioning.dispose(input, options) });
    if (!disposed.ok) return disposed;
    return disabled;
  }

  /** Publishes enabled state last; failure revokes admission and cleans resources. @complexity O(1). */
  async function enableAdmitted(input: Invocation & { plugin: InstalledPlugin }, options?: CallOptions): Promise<Outcome<InstalledPlugin>> {
    const prepared = await required.repo.save({ context: input.context, plugin: { ...input.plugin, enabled: false } }, options);
    if (!prepared.ok) return prepared;
    const provisioned = await attempt({ run: () => required.provisioning.provision({ context: input.context, plugin: input.plugin }, options) });
    if (!provisioned.ok) {
      const cleaned = await close(input, options);
      if (!cleaned.ok) return cleaned;
      return provisioned;
    }
    const saved = await attempt({ run: () => required.repo.save({ context: input.context, plugin: { ...input.plugin, enabled: true } }, options) });
    if (saved.ok) return saved;
    const cleaned = await close(input, options);
    if (!cleaned.ok) return cleaned;
    return saved;
  }

  /** Running jobs block removal; pending disposal retains closed metadata for retry. @complexity O(1). */
  async function uninstall(input: Invocation, options?: CallOptions): Promise<Outcome<UninstallReceipt>> {
    const audited = await required.audit.record({ ...input, operation: "uninstall.requested" }, options);
    if (!audited.ok) return audited;
    const idle = await required.lifecycle.checkIdle(input, options);
    if (!idle.ok) return idle;
    const closed = await close(input, options);
    if (!closed.ok) return closed;
    const disposed = await required.lifecycle.dispose(input, options);
    if (!disposed.ok) return disposed;
    if (disposed.value.status === "pending") return disposed;
    const removed = await required.repo.remove(input, options);
    if (!removed.ok) return removed;
    return disposed;
  }

  return {
    async install(input, options) {
      const parsed = parseBoundary({ schema: installSchema, input });
      if (!parsed.ok) return parsed;
      return invoke({ context: parsed.value.context, operation: "plugins.install", run: () => install(parsed.value, options) }, options);
    },
    async setEnabled(input, options) {
      const parsed = parseBoundary({ schema: enableSchema, input });
      if (!parsed.ok) return parsed;
      return invoke({ context: parsed.value.context, operation: "plugins.setEnabled", run: () => setEnabled(parsed.value, options) }, options);
    },
    async uninstall(input, options) {
      const parsed = parseBoundary({ schema: removeSchema, input });
      if (!parsed.ok) return parsed;
      return invoke({ context: parsed.value.context, operation: "plugins.uninstall", run: () => uninstall(parsed.value, options) }, options);
    },
  };
}
