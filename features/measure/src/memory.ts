import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, scopeSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, IdPort, Outcome, Scope } from "@open-marketing/contracts";
import type { ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionSourceAuthenticationPort, MeasureAuditPort, MeasureJobPort, MeasurementGrantPort, MeasurementShareabilityPort, PlatformReportingPort } from "./ports.js";
import type { ConversionDispatchRecord, MeasureGrant, PlatformMetricSnapshot, VerifiedConversionSource } from "./types.js";
import { mergeDeliveryDiagnostics, validateDeliveryTransition } from "./delivery/ledger-rules.js";
import { auditInputSchema, clone, conversionKey, conversionSchema, deliveryStateInputSchema, eventIdentity, failure, grantInputSchema, measureGrantSchema, nextId, parseSourceEvent, querySchema, revokeInputSchema, sameScope, serviceContextSchema, scopeKey, snapshotSchema, sourceSchema, storageLimit } from "./rules.js";
import { deliveryIdentity, parseReconciliationInput, parseResolvedDeliveryInput } from "./delivery/input.js";
import { conversionDeliveryOutcomeSchema } from "./types.js";
import type { ConversionDeliveryOutcome, ConversionDiagnostics } from "./types.js";
export { createMemoryTrackedLink } from "./links/links.js";

/** Test evidence is exact-purpose/destination-bound. No evidence means denial. */
export type MemoryConsentEvidence = { readonly scope: Scope; readonly subjectId: string; readonly destination: string; readonly purpose: string; readonly identifierKeys: readonly string[]; readonly expiresAt: number; readonly withdrawn: boolean };
const consentEvidenceSchema = z.array(z.strictObject({ scope: scopeSchema, subjectId: idSchema, destination: idSchema, purpose: idSchema, identifierKeys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(16), expiresAt: epochSchema, withdrawn: z.boolean() })).max(1000);
/** Mutable consent double supports withdrawal between ingestion and dispatch.
 * @example createMemoryMeasurementShareability({ clock, evidence: [consent] })
 * @complexity O(e+k), capped at 1000 evidence records and 16 identifier keys. */
export function createMemoryMeasurementShareability(required: { clock?: ClockPort; evidence?: readonly MemoryConsentEvidence[] }): MeasurementShareabilityPort & { replace(required: { evidence: readonly MemoryConsentEvidence[] }): void } {
  let evidence = clone({ value: required.evidence?.slice(0, 1001) ?? [] });
  return {
    replace(input) { evidence = clone({ value: input.evidence.slice(0, 1001) }); },
    async assess(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: conversionSchema, input: input.event });
      if (!parsed.ok) return parsed;
      if (!required.clock || evidence.length > 1000) return failure({ code: "unavailable", message: "Bounded consent evidence and clock are required" });
      const bounded = parseBoundary({ schema: consentEvidenceSchema, input: evidence });
      if (!bounded.ok) return bounded;
      const now = required.clock.now({});
      const matches = bounded.value.filter(item => sameScope({ left: item.scope, right: input.context.scope }) && item.subjectId === parsed.value.subjectId && item.destination === parsed.value.destination && item.purpose === parsed.value.purpose);
      if (matches.some(item => item.withdrawn)) return { ok: true, value: { allowed: false, reason: "withdrawn" } };
      // phone_digits is an alias of phone: contacts derives both from the same HMAC.
      const allowed = matches.some(item => item.expiresAt > now && Object.keys(parsed.value.identifierDigests).every(key => item.identifierKeys.includes(key) || (key === "phone_digits" && item.identifierKeys.includes("phone"))));
      return { ok: true, value: { allowed, reason: allowed ? undefined : "missing_purpose_bound_consent" } };
    },
  };
}
/** Current authenticated source registry double; revision/scope mismatches deny. */
export function createMemoryConversionSourceAuthentication(required: { sources?: readonly VerifiedConversionSource[] }): ConversionSourceAuthenticationPort & { replace(required: { sources: readonly VerifiedConversionSource[] }): void } {
  let sources = clone({ value: required.sources?.slice(0, 1001) ?? [] });
  return {
    replace(input) { sources = clone({ value: input.sources.slice(0, 1001) }); },
    async verify(input) {
      const parsed = parseBoundary({ schema: sourceSchema, input: input.source });
      if (!parsed.ok) return parsed;
      if (sources.length > 1000) return failure({ code: "limit_exceeded", message: "Source registry limit" });
      const registry = parseBoundary({ schema: z.array(sourceSchema).max(1000), input: sources });
      if (!registry.ok) return registry;
      const authenticated = registry.value.some(item => item.sourceId === parsed.value.sourceId && item.authenticationRevision === parsed.value.authenticationRevision && sameScope({ left: item.scope, right: parsed.value.scope }));
      return { ok: true, value: { authenticated } };
    },
  };
}
/** Append-only redacted audit double. Inspection returns detached values. */
export function createMemoryMeasureAudit(required: { maxRecords?: number }): MeasureAuditPort & { inspect(required: Record<string, never>): readonly { context: CallContext; operationId: string; outcome: string }[] } {
  const limit = storageLimit(required);
  const records: { context: CallContext; operationId: string; outcome: string }[] = [];
  return {
    async record(input) {
      const parsed = parseBoundary({ schema: auditInputSchema, input });
      if (!parsed.ok) return parsed;
      if (records.length >= limit) return failure({ code: "limit_exceeded", message: "Audit storage limit" });
      records.push(clone({ value: parsed.value }));
      return { ok: true, value: undefined };
    },
    inspect() { return clone({ value: records }); },
  };
}
/** Standalone outbox boundary double; production ingestion binds jobs inside repo transaction. */
export function createMemoryMeasureJob(required: { ids?: IdPort; maxRecords?: number }): MeasureJobPort {
  const limit = storageLimit(required);
  const records = new Map<string, { identity: string; jobId: string }>();
  let sequence = 0;
  return {
    async enqueue(input) {
      const parsed = parseSourceEvent({ input });
      if (!parsed.ok) return parsed;
      const key = conversionKey(parsed.value);
      const identity = eventIdentity({ event: parsed.value.event });
      const existing = records.get(key);
      if (existing && existing.identity !== identity) return failure({ code: "conflict", message: "Conflicting job identity" });
      if (existing) return { ok: true, value: { jobId: existing.jobId } };
      if (records.size >= limit) return failure({ code: "limit_exceeded", message: "Job storage limit" });
      const id = nextId({ ids: required.ids, fallback: "job-" + ++sequence });
      if (!id.ok) return id;
      records.set(key, { identity, jobId: id.value });
      return { ok: true, value: { jobId: id.value } };
    },
  };
}
/** Reporting fixture must be explicitly seeded; an empty fixture never invents spend. */
export function createMemoryPlatformReporting(required: { snapshot?: PlatformMetricSnapshot }): PlatformReportingPort {
  const value = clone({ value: required.snapshot });
  return {
    async snapshot(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const query = parseBoundary({ schema: querySchema, input: input.query });
      if (!query.ok) return query;
      if (!value) return failure({ code: "unavailable", message: "No platform report fixture" });
      return parseBoundary({ schema: snapshotSchema, input: value });
    },
  };
}
/** Local backend fixture with stable delivery identity. Unknown outcomes remain unknown
 * until reconcileStatus is explicitly supplied; no automatic resend.
 * Vendor diagnostics must be seeded explicitly; transport status never invents them.
 * @complexity O(1) map calls, bounded at maxRecords. */
export function createMemoryConversionDelivery(required: { status?: "delivered" | "unknown"; diagnostics?: ConversionDiagnostics; reconcileStatus?: "delivered" | "unknown"; reconcileDiagnostics?: ConversionDiagnostics; maxRecords?: number }): ConversionDeliveryPort & { calls(required: Record<string, never>): number } {
  const limit = storageLimit(required);
  const records = new Map<string, ConversionDeliveryOutcome & { identity: string }>();
  let calls = 0;
  return {
    async deliver(input) {
      const parsed = parseResolvedDeliveryInput({ input });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.deliveryId]);
      const identity = deliveryIdentity({ input: parsed.value });
      const previous = records.get(key);
      if (previous) return deliveryDuplicate({ previous, identity });
      if (records.size >= limit) return failure({ code: "limit_exceeded", message: "Delivery storage limit" });
      const status = required.status ?? "delivered";
      const outcome = parseBoundary({ schema: conversionDeliveryOutcomeSchema, input: { status, diagnostics: required.diagnostics } });
      if (!outcome.ok) return outcome;
      records.set(key, clone({ value: { identity, ...outcome.value } }));
      calls++;
      return outcome;
    },
    async reconcile(input) {
      const parsed = parseReconciliationInput({ input });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.deliveryId]);
      const previous = records.get(key);
      if (!previous) return failure({ code: "unavailable", message: "No delivery evidence" });
      const checked = deliveryDuplicate({ previous, identity: deliveryIdentity({ input: parsed.value }) });
      if (!checked.ok) return checked;
      if (previous.status === "not_sent") return checked;
      const status = previous.status === "delivered" ? "delivered" : required.reconcileStatus ?? previous.status;
      const outcome = parseBoundary({ schema: conversionDeliveryOutcomeSchema, input: { status, diagnostics: required.reconcileDiagnostics ?? previous.diagnostics } });
      if (!outcome.ok) return outcome;
      records.set(key, clone({ value: { ...previous, ...outcome.value } }));
      return outcome;
    },
    calls() { return calls; },
  };
}
function deliveryDuplicate(required: { previous: ConversionDeliveryOutcome & { identity: string }; identity: string }): Outcome<ConversionDeliveryOutcome> {
  if (required.previous.identity !== required.identity) return failure({ code: "conflict", message: "Conflicting delivery payload" });
  const { identity: _identity, ...outcome } = required.previous;
  return parseBoundary({ schema: conversionDeliveryOutcomeSchema, input: outcome });
}
/** Bounded scoped authority; identical grants cannot revive a revoked ID.
 * replace remains a fault-injection seam. Results are detached from stored state.
 * @example createMemoryMeasurementGrant({}).grant({ context, grant })
 * @complexity O(n) time/space per operation for at most 1000 grants. */
export function createMemoryMeasurementGrant(required: { grants?: readonly MeasureGrant[] }): MeasurementGrantPort & { replace(required: { grants: readonly MeasureGrant[] }): void } {
  let grants = clone({ value: required.grants?.slice(0, 1001) ?? [] });
  function registry(): Outcome<MeasureGrant[]> {
    if (grants.length > 1000) return failure({ code: "limit_exceeded", message: "Grant registry limit" });
    return parseBoundary({ schema: z.array(measureGrantSchema).max(1000), input: grants });
  }
  return {
    replace(input) { grants = clone({ value: input.grants.slice(0, 1001) }); },
    async current(input) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: serviceContextSchema, grantId: idSchema }), input });
      if (!parsed.ok) return parsed;
      const stored = registry();
      if (!stored.ok) return stored;
      const grant = stored.value.find(item => item.grantId === parsed.value.grantId && sameScope({ left: item.scope, right: parsed.value.context.scope }));
      if (!grant) return failure({ code: "forbidden", message: "Measurement grant not found" });
      return parseBoundary({ schema: measureGrantSchema, input: grant });
    },
    async grant(input) {
      const parsed = parseBoundary({ schema: grantInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, grant } = parsed.value;
      if (grant.revoked || !sameScope({ left: grant.scope, right: context.scope })) return failure({ code: "forbidden", message: "Measurement grant scope or state mismatch" });
      const stored = registry();
      if (!stored.ok) return stored;
      const previous = stored.value.find(item => item.grantId === grant.grantId && sameScope({ left: item.scope, right: context.scope }));
      if (previous) {
        // Strict schema parsing fixes property order before JSON comparison.
        if (JSON.stringify({ ...previous, revoked: false }) !== JSON.stringify(grant)) return failure({ code: "conflict", message: "Measurement grant ID already binds different content" });
        return { ok: true, value: previous };
      }
      if (stored.value.length >= 1000) return failure({ code: "limit_exceeded", message: "Grant registry limit" });
      grants = [...stored.value, grant];
      return { ok: true, value: clone({ value: grant }) };
    },
    async revoke(input) {
      const parsed = parseBoundary({ schema: revokeInputSchema, input });
      if (!parsed.ok) return parsed;
      const stored = registry();
      if (!stored.ok) return stored;
      const grant = stored.value.find(item => item.grantId === parsed.value.grantId && sameScope({ left: item.scope, right: parsed.value.context.scope }));
      if (!grant) return failure({ code: "forbidden", message: "Measurement grant not found" });
      grant.revoked = true;
      grants = stored.value;
      return { ok: true, value: clone({ value: grant }) };
    },
  };
}
/** Atomic dispatch claim and immutable history double; duplicate claims cannot send again.
 * Scoped reads return detached evidence; appends merge diagnostics and preserve confirmed stages.
 * @example createMemoryConversionDeliveryState({}).read({ context, deliveryId })
 * @complexity O(1) bounded map operations; history is capped by maxRecords. */
export function createMemoryConversionDeliveryState(required: { maxRecords?: number }): ConversionDeliveryStatePort & { history(required: Record<string, never>): readonly ConversionDispatchRecord[] } {
  const limit = storageLimit(required);
  const latest = new Map<string, ConversionDispatchRecord>();
  const history: ConversionDispatchRecord[] = [];
  return {
    async read(input) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: serviceContextSchema, deliveryId: idSchema }), input });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.deliveryId]);
      return { ok: true, value: clone({ value: latest.get(key) ?? null }) };
    },
    async begin(input) {
      const parsed = parseBoundary({ schema: deliveryStateInputSchema, input });
      if (!parsed.ok) return parsed;
      if (parsed.value.record.status !== "dispatching") return failure({ code: "invalid_input", message: "Claim must begin dispatching" });
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.record.deliveryId]);
      const previous = latest.get(key);
      if (previous) return existingClaim({ previous, record: parsed.value.record });
      if (history.length >= limit) return failure({ code: "limit_exceeded", message: "Delivery ledger limit" });
      latest.set(key, clone({ value: parsed.value.record }));
      history.push(clone({ value: parsed.value.record }));
      return { ok: true, value: { acquired: true, record: parsed.value.record } };
    },
    async append(input) {
      const parsed = parseBoundary({ schema: deliveryStateInputSchema, input });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.record.deliveryId]);
      const previous = latest.get(key);
      const valid = validateDeliveryTransition({ previous, record: parsed.value.record });
      if (!valid.ok) return valid;
      if (history.length >= limit) return failure({ code: "limit_exceeded", message: "Delivery ledger limit" });
      const record = clone({ value: { ...parsed.value.record, diagnostics: mergeDeliveryDiagnostics({ before: previous?.diagnostics, after: parsed.value.record.diagnostics }) } });
      latest.set(key, clone({ value: record }));
      history.push(clone({ value: record }));
      return { ok: true, value: record };
    },
    history() { return clone({ value: history }); },
  };
}
function existingClaim(required: { previous: ConversionDispatchRecord; record: ConversionDispatchRecord }): Outcome<{ acquired: boolean; record: ConversionDispatchRecord }> {
  if (required.previous.identity !== required.record.identity || required.previous.subjectId !== required.record.subjectId || required.previous.eventId !== required.record.eventId) return failure({ code: "conflict", message: "Delivery ID already binds another payload" });
  return { ok: true, value: { acquired: false, record: clone({ value: required.previous }) } };
}
