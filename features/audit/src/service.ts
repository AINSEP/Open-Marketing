import type { CallContext, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { AuditRedactorPort, AuditRepoPort } from "./ports.js";
import type { AuditEntry, AuditPage, AuditQuery, AuditReceipt, AuditService } from "./types.js";
import { auditEntrySchema } from "./types.js";
import { auditPageSchema, auditReceiptSchema, failure, parseOutcome, validateAppend, validateList } from "./validation.js";
import { observe } from "./observation.js";

/** Inert orchestration: commit required evidence before success; redact only operational reads.
 * @example createAuditService({ repo, redactor }, { observer });
 * @returns Typed failures on invalid input, unavailable dependencies or invalid output; never starts effects.
 * @complexity O(r) record, O(p*r) list, p <=100, r <=64; no unbounded export buffer.
 */
export function createAuditService(required: {
  repo: AuditRepoPort; redactor: AuditRedactorPort;
}, optional?: { observer?: ObserverPort }): AuditService {
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

/** Reject adapters violating page bounds or cursor progress. @complexity One read plus O(p*r) redaction. */
async function readPage(required: {
  repo: AuditRepoPort; redactor: AuditRedactorPort; context: CallContext; query: AuditQuery;
}, optional?: CallOptions): Promise<Outcome<AuditPage>> {
  try {
    const result = parseOutcome({ input: await required.repo.list(structuredClone({ context: required.context, query: required.query }), optional), schema: auditPageSchema });
    if (!result.ok) return result;
    if (result.value.items.length > required.query.limit) return failure({ code: "protocol_mismatch" });
    if (result.value.cursor === required.query.cursor) return failure({ code: "protocol_mismatch" });
    return await redactPage({ ...required, page: result.value }, optional);
  } catch { return failure({ code: "unavailable" }); }
}

/** No partial page escapes when any redaction fails or cancellation arrives during the last await.
 * @complexity O(p*r), bounded page space; empty pages also honor cancellation.
 */
async function redactPage(required: {
  redactor: AuditRedactorPort; context: CallContext; page: AuditPage; query: AuditQuery;
}, optional?: CallOptions): Promise<Outcome<AuditPage>> {
  const items: AuditEntry[] = [];
  for (const entry of required.page.items) {
    const redacted = await redactEntry({ ...required, entry }, optional);
    if (!redacted.ok) return redacted;
    items.push(redacted.value);
  }
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return { ok: true, value: { items, cursor: required.page.cursor } };
}

/** Validate one operational projection against the untouched evidence and requested operation.
 * @returns Typed cancellation/protocol/redactor failure; exceptions are mapped by readPage.
 * @complexity One injected redaction, O(r) clone/parse space, r <=64 references.
 */
async function redactEntry(required: {
  redactor: AuditRedactorPort; context: CallContext; entry: AuditEntry; query: AuditQuery;
}, optional?: CallOptions): Promise<Outcome<AuditEntry>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (required.query.operationId !== undefined && required.entry.operationId !== required.query.operationId) return failure({ code: "protocol_mismatch" });
  const redacted = parseOutcome({ input: await required.redactor.redact(structuredClone({ context: required.context, entry: required.entry }), optional), schema: auditEntrySchema });
  if (!redacted.ok) return redacted;
  if (!sameEvidence({ original: required.entry, projected: redacted.value })) return failure({ code: "protocol_mismatch" });
  return redacted;
}

function sameEvidence(required: { original: AuditEntry; projected: AuditEntry }): boolean {
  return required.original.operationId === required.projected.operationId
    && required.original.kind === required.projected.kind
    && required.original.argumentsDigest === required.projected.argumentsDigest
    && required.original.correctionOf === required.projected.correctionOf
    && JSON.stringify(required.original.approval) === JSON.stringify(required.projected.approval);
}
