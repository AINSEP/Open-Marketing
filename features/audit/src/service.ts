import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { AuditObserverPort, AuditRedactorPort, AuditRepoPort } from "./ports.js";
import type { AuditEntry, AuditPage, AuditQuery, AuditReceipt, AuditService } from "./types.js";
import { auditEntrySchema, auditPageSchema, auditReceiptSchema, failure, parseOutcome, validateAppend, validateList } from "./validation.js";
import { observe } from "./observation.js";

/** Inert orchestration: commit required evidence before success; redact only operational reads.
 * Clock/IDs remain in the accepted signature; repositories allocate receipts with those same ports.
 * @example createAuditService({ repo, clock, ids, redactor }, { observer });
 * @returns Typed failures on invalid input, unavailable dependencies or invalid output; never starts effects.
 * @complexity O(r) record, O(p*r) list, p <=100, r <=64; no unbounded export buffer.
 */
export function createAuditService(required: {
  repo: AuditRepoPort; clock: ClockPort; ids: IdPort; redactor: AuditRedactorPort;
}, optional?: { observer?: AuditObserverPort }): AuditService {
  return {
    async record(input, options) {
      const parsed = validateAppend({ input }, options);
      if (!parsed.ok) return parsed;
      const result = await append({ repo: required.repo, ...parsed.value }, options);
      observe({ observer: optional?.observer, context: parsed.value.context, operation: "audit.record", outcome: result });
      return result;
    },
    async list(input, options) {
      const parsed = validateList({ input }, options);
      if (!parsed.ok) return parsed;
      const result = await readPage({ ...required, ...parsed.value }, options);
      observe({ observer: optional?.observer, context: parsed.value.context, operation: "audit.list", outcome: result });
      return result;
    },
  };
}

/** Append exceptions/messages stop here; success requires a validated receipt.
 * @complexity One append and bounded receipt validation.
 */
async function append(required: { repo: AuditRepoPort; context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditReceipt>> {
  try {
    const result = await required.repo.append(structuredClone({ context: required.context, entry: required.entry }), optional);
    return parseOutcome({ input: result, schema: auditReceiptSchema });
  } catch { return failure({ code: "unavailable" }); }
}

/** Reject adapters violating requested page bounds. @complexity One read plus O(p*r) redaction. */
async function readPage(required: {
  repo: AuditRepoPort; redactor: AuditRedactorPort; context: CallContext; query: AuditQuery;
}, optional?: CallOptions): Promise<Outcome<AuditPage>> {
  try {
    const result = parseOutcome({ input: await required.repo.list(structuredClone({ context: required.context, query: required.query }), optional), schema: auditPageSchema });
    if (!result.ok) return result;
    if (result.value.items.length > required.query.limit) return failure({ code: "protocol_mismatch" });
    return await redactPage({ ...required, page: result.value }, optional);
  } catch { return failure({ code: "unavailable" }); }
}

/** No partial page escapes when any redaction fails. @complexity O(p*r), bounded page space. */
async function redactPage(required: {
  redactor: AuditRedactorPort; context: CallContext; page: AuditPage; query: AuditQuery;
}, optional?: CallOptions): Promise<Outcome<AuditPage>> {
  const items: AuditEntry[] = [];
  for (const entry of required.page.items) {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (required.query.operationId !== undefined && entry.operationId !== required.query.operationId) return failure({ code: "protocol_mismatch" });
    const redacted = parseOutcome({ input: await required.redactor.redact(structuredClone({ context: required.context, entry }), optional), schema: auditEntrySchema });
    if (!redacted.ok) return redacted;
    if (!sameEvidence({ original: entry, projected: redacted.value })) return failure({ code: "protocol_mismatch" });
    items.push(redacted.value);
  }
  return { ok: true, value: { items, cursor: required.page.cursor } };
}

function sameEvidence(required: { original: AuditEntry; projected: AuditEntry }): boolean {
  return required.original.operationId === required.projected.operationId
    && required.original.kind === required.projected.kind
    && required.original.argumentsDigest === required.projected.argumentsDigest
    && required.original.correctionOf === required.projected.correctionOf;
}
