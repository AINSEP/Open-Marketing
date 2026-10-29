import type { BrandRepoPort } from "../ports.js";
import { appendSchema, checkBrandAppend, contextSchema, parseBrandInput, readSchema } from "../schemas.js";
import type { BrandRevision } from "../schemas.js";

/** Instance-owned append-only history; no I/O, globals or mutable snapshots escape.
 * Typed validation/CAS/authority errors; O(b) per snapshot, O(n*b) retained history.
 * @example const repo = createMemoryBrandRepo({});
 */
export function createMemoryBrandRepo(required: Record<string, never>): BrandRepoPort {
  const scopes = new Map<string, { revisions: BrandRevision[]; confirmed: BrandRevision | null }>();
  return {
    async read(input, options) {
      const parsed = parseBrandInput({ schema: readSchema, input }, options);
      if (!parsed.ok) return parsed;
      const state = scopes.get(JSON.stringify(parsed.value.context.scope));
      const revision = parsed.value.revision;
      const value = revision === undefined ? state?.revisions.at(-1) : state?.revisions[revision - 1];
      return { ok: true, value: structuredClone(value ?? null) };
    },
    async readConfirmed(input, options) {
      const parsed = parseBrandInput({ schema: contextSchema, input }, options);
      if (!parsed.ok) return parsed;
      return { ok: true, value: structuredClone(scopes.get(JSON.stringify(parsed.value.context.scope))?.confirmed ?? null) };
    },
    async append(input, options) {
      const parsed = parseBrandInput({ schema: appendSchema, input }, options);
      if (!parsed.ok) return parsed;
      const key = JSON.stringify(parsed.value.context.scope);
      const state = scopes.get(key) ?? { revisions: [], confirmed: null };
      const checked = checkBrandAppend({ input: parsed.value, current: state.revisions.at(-1) ?? null });
      if (!checked.ok) return checked;
      state.revisions.push(checked.value);
      if (checked.value.status === "confirmed") state.confirmed = checked.value;
      scopes.set(key, state);
      return { ok: true, value: structuredClone(checked.value) };
    },
  };
}
