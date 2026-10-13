import type { PrivacyRepoPort } from "./ports.js";
import type { ErasureRequest } from "./types.js";
import { checkCreate, checkTransition, failure, parseRequest, sameRecord, scopeKey, validateInput } from "./validation.js";

/** Isolated lifecycle storage; clones every input/output, preserving digests and completed progress.
 * @example const repo = createMemoryPrivacyRepo({}); await repo.get({ context, requestId });
 * @complexity O(p+d) bounded validation per operation, O(r*(p+d)) state for r requests.
 */
export function createMemoryPrivacyRepo(_required: Record<string, never>): PrivacyRepoPort {
  const requests = new Map<string, ErasureRequest>();
  return {
    async create(input, options) {
      const invalid = validateInput({ context: input.context, id: input.request?.requestId, options });
      if (invalid) return invalid;
      const parsed = parseRequest(input);
      if (!parsed.ok) return parsed;
      const denied = checkCreate({ request: parsed.value });
      if (denied) return denied;
      const key = scopeKey({ scope: input.context.scope, id: parsed.value.requestId });
      const previous = requests.get(key);
      if (previous && !sameRecord({ left: previous, right: parsed.value })) return failure({ code: "conflict", message: "Erasure request already exists" });
      requests.set(key, parsed.value);
      return { ok: true, value: structuredClone(parsed.value) };
    },
    async get(input, options) {
      const invalid = validateInput({ context: input.context, id: input.requestId, options });
      if (invalid) return invalid;
      return { ok: true, value: structuredClone(requests.get(scopeKey({ scope: input.context.scope, id: input.requestId })) ?? null) };
    },
    async save(input, options) {
      const invalid = validateInput({ context: input.context, id: input.request?.requestId, options });
      if (invalid) return invalid;
      const parsed = parseRequest(input);
      if (!parsed.ok) return parsed;
      const key = scopeKey({ scope: input.context.scope, id: parsed.value.requestId });
      const previous = requests.get(key);
      if (!previous) return failure({ code: "unavailable", message: "Erasure request missing" });
      const denied = checkTransition({ previous, next: parsed.value });
      if (denied) return denied;
      requests.set(key, parsed.value);
      return { ok: true, value: structuredClone(parsed.value) };
    },
  };
}
