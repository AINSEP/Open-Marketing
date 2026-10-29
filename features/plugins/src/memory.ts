import { addonSummarySchema } from '@open-marketing/contracts';
import type { AddonSummary, CallContext, ObserverEvent, ObserverPort } from '@open-marketing/contracts';
import type { PluginAuditPort } from './ports.js';
import type { AddonRepository } from './types.js';
import { success } from './results.js';

/** Canonical scope identity is independent of object property insertion order. */
function scopeKey(required: { context: CallContext }): string {
    return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]);
}

/** Scoped clone-on-read/write double of the SQL catalog. At most 1000 entries per scope. */
export function createMemoryPluginRepo(_required: Record<string, never>): AddonRepository {
    const scopes = new Map<string, Map<string, AddonSummary>>();
    return {
        async list({ context }) { return structuredClone([...(scopes.get(scopeKey({ context }))?.values() ?? [])]); },
        async save({ context, addon }) {
            const value = addonSummarySchema.parse(addon);
            const key = scopeKey({ context });
            const rows = scopes.get(key) ?? new Map();
            if (rows.size >= 1000 && !rows.has(value.kind + ':' + value.id)) throw new RangeError('Addon catalog limit');
            rows.set(value.kind + ':' + value.id, structuredClone(value));
            scopes.set(key, rows);
        },
        async remove({ context, kind, id }) { scopes.get(scopeKey({ context }))?.delete(kind + ':' + id); },
    };
}

type AuditEntry = Parameters<PluginAuditPort["record"]>[0];
/** Append-only audit double; records clone operation IDs and caller scope.
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
export function createMemoryPluginObserver(_required: Record<string, never>): ObserverPort & { events(required: Record<string, never>): readonly ObserverEvent[] } {
  const events: ObserverEvent[] = [];
  return { observe(input) { events.push(structuredClone(input)); }, events() { return structuredClone(events); } };
}
