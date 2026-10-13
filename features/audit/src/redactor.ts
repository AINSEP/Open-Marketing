import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { AuditRedactorPort } from "./ports.js";
import type { AuditEntry } from "./types.js";
import { failure, operationalId, validateAppend } from "./validation.js";

/** Adapter for the published @jini-ai/core 0.4.3 redactSecrets function. Composition adapts
 * its public input object; audit never copies Jini's secret/PII patterns.
 * @example createJiniAuditRedactor({ scrubber: { redact: ({ text }) => redactSecrets({ input: text }) } });
 * @returns A typed failure if scrubber fails or an identity contains recognized sensitive content.
 * @complexity O(r*s), r <=64, s <=256; scrubber cost is injected and must remain bounded.
 */
export function createJiniAuditRedactor(required: {
  scrubber: { redact(required: { text: string }): string };
}): AuditRedactorPort {
  return {
    async redact(input, optional) {
      const parsed = validateAppend({ input }, optional);
      if (!parsed.ok) return parsed;
      try {
        return scrubEntry({ ...required, ...parsed.value });
      } catch { return failure({ code: "unavailable" }); }
    },
  };
}

/** Never rewrite lineage or operational identifiers to manufacture apparently valid evidence.
 * Sensitive identities fail closed. References are withheld entirely because a lexical detector
 * cannot recognize arbitrary names, addresses or business secrets. @complexity O(r*s).
 */
function scrubEntry(required: {
  scrubber: { redact(required: { text: string }): string }; context: CallContext; entry: AuditEntry;
}): Outcome<AuditEntry> {
  const { entry, scrubber } = required;
  if (!safeIdentity({ value: entry.operationId, scrubber })) return failure({ code: "forbidden" });
  if (entry.correctionOf !== undefined && !safeIdentity({ value: entry.correctionOf, scrubber })) return failure({ code: "forbidden" });
  const references = entry.references.map(() => "[redacted]");
  return { ok: true, value: { ...entry, references } };
}

function safeIdentity(required: { value: string; scrubber: { redact(required: { text: string }): string } }): boolean {
  return operationalId(required) === required.value
    && required.scrubber.redact({ text: required.value }) === required.value;
}

/** Conservative test/local projection without a lexical detector: withhold all references.
 * Payload-shaped identity fields fail rather than corrupt lineage. @complexity O(r), r <=64.
 */
export function withholdReferences(required: {
  context: CallContext; entry: AuditEntry;
}, optional?: CallOptions): Outcome<AuditEntry> {
  const parsed = validateAppend({ input: required }, optional);
  if (!parsed.ok) return parsed;
  const { entry } = parsed.value;
  if (operationalId({ value: entry.operationId }) !== entry.operationId) return failure({ code: "forbidden" });
  if (entry.correctionOf !== undefined && operationalId({ value: entry.correctionOf }) !== entry.correctionOf) return failure({ code: "forbidden" });
  return { ok: true, value: { ...entry, references: entry.references.map(() => "[redacted]") } };
}
