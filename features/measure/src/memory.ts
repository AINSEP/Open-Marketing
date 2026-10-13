import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, scopeSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, IdPort, Outcome, Scope } from "@open-marketing/contracts";
import type { ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionSourceAuthenticationPort, MeasureAuditPort, MeasureJobPort, MeasurementGrantPort, MeasurementShareabilityPort, PlatformReportingPort } from "./ports.js";
import type { ConversionDispatchRecord, MeasureGrant, PlatformMetricSnapshot, VerifiedConversionSource } from "./types.js";
import { validateDeliveryTransition } from "./delivery/ledger-rules.js";
import { auditInputSchema, clone, conversionKey, conversionSchema, dispatchRecordSchema, eventIdentity, failure, measureGrantSchema, nextId, parseSourceEvent, querySchema, sameScope, serviceContextSchema, scopeKey, snapshotSchema, sourceSchema, storageLimit } from "./rules.js";
import { deliveryIdentity, parseResolvedDeliveryInput } from "./delivery/input.js";
export { createMemoryMeasureRepo } from "./adapters/memory-repo.js";
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
      const allowed = matches.some(item => item.expiresAt > now && Object.keys(parsed.value.identifierDigests).every(key => item.identifierKeys.includes(key)));
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
 * @complexity O(1) map calls, bounded at maxRecords. */
export function createMemoryConversionDelivery(required: { status?: "delivered" | "unknown"; reconcileStatus?: "delivered" | "unknown"; maxRecords?: number }): ConversionDeliveryPort & { calls(required: Record<string, never>): number } {
  const limit = storageLimit(required);
  const records = new Map<string, { identity: string; status: "delivered" | "unknown" }>();
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
      records.set(key, { identity, status });
      calls++;
      return { ok: true, value: { status } };
    },
    async reconcile(input) {
      const parsed = parseResolvedDeliveryInput({ input });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: parsed.value.context.scope }), parsed.value.deliveryId]);
      const previous = records.get(key);
      if (!previous) return failure({ code: "unavailable", message: "No delivery evidence" });
      const checked = deliveryDuplicate({ previous, identity: deliveryIdentity({ input: parsed.value }) });
      if (!checked.ok) return checked;
      const status = previous.status === "delivered" ? "delivered" : required.reconcileStatus ?? previous.status;
      records.set(key, { ...previous, status });
      return { ok: true, value: { status } };
    },
    calls() { return calls; },
  };
}
function deliveryDuplicate(required: { previous: { identity: string; status: "delivered" | "unknown" }; identity: string }): Outcome<{ status: "delivered" | "unknown" }> {
  if (required.previous.identity !== required.identity) return failure({ code: "conflict", message: "Conflicting delivery payload" });
  return { ok: true, value: { status: required.previous.status } };
}
/** Grant registry permits explicit revocation in tests; never grants a generic tool scope. */
export function createMemoryMeasurementGrant(required: { grants?: readonly MeasureGrant[] }): MeasurementGrantPort & { replace(required: { grants: readonly MeasureGrant[] }): void } {
  let grants = clone({ value: required.grants?.slice(0, 1001) ?? [] });
  return {
    replace(input) { grants = clone({ value: input.grants.slice(0, 1001) }); },
    async current(input) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: serviceContextSchema, grantId: idSchema }), input });
      if (!parsed.ok) return parsed;
      if (grants.length > 1000) return failure({ code: "limit_exceeded", message: "Grant registry limit" });
      const registry = parseBoundary({ schema: z.array(measureGrantSchema).max(1000), input: grants });
      if (!registry.ok) return registry;
      const grant = registry.value.find(item => item.grantId === input.grantId && sameScope({ left: item.scope, right: input.context.scope }));
      if (!grant) return failure({ code: "forbidden", message: "Measurement grant not found" });
      return parseBoundary({ schema: measureGrantSchema, input: grant });
    },
  };
}
/** Atomic dispatch claim and immutable history double; duplicate claims cannot send again. */
export function createMemoryConversionDeliveryState(required: { maxRecords?: number }): ConversionDeliveryStatePort & { history(required: Record<string, never>): readonly ConversionDispatchRecord[] } {
  const limit = storageLimit(required);
  const latest = new Map<string, ConversionDispatchRecord>();
  const history: ConversionDispatchRecord[] = [];
  return {
    async begin(input) {
      const context = parseBoundary({ schema: serviceContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: dispatchRecordSchema, input: input.record });
      if (!parsed.ok) return parsed;
      if (parsed.value.status !== "dispatching") return failure({ code: "invalid_input", message: "Claim must begin dispatching" });
      const key = JSON.stringify([scopeKey({ scope: input.context.scope }), parsed.value.deliveryId]);
      const previous = latest.get(key);
      if (previous) return existingClaim({ previous, record: parsed.value });
      if (history.length >= limit) return failure({ code: "limit_exceeded", message: "Delivery ledger limit" });
      latest.set(key, clone({ value: parsed.value }));
      history.push(clone({ value: parsed.value }));
      return { ok: true, value: { acquired: true, record: parsed.value } };
    },
    async append(input) {
      const context = parseBoundary({ schema: serviceContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: dispatchRecordSchema, input: input.record });
      if (!parsed.ok) return parsed;
      const key = JSON.stringify([scopeKey({ scope: input.context.scope }), parsed.value.deliveryId]);
      const previous = latest.get(key);
      const valid = validateDeliveryTransition({ previous, record: parsed.value });
      if (!valid.ok) return valid;
      if (history.length >= limit) return failure({ code: "limit_exceeded", message: "Delivery ledger limit" });
      latest.set(key, clone({ value: parsed.value }));
      history.push(clone({ value: parsed.value }));
      return parsed;
    },
    history() { return clone({ value: history }); },
  };
}
function existingClaim(required: { previous: ConversionDispatchRecord; record: ConversionDispatchRecord }): Outcome<{ acquired: boolean; record: ConversionDispatchRecord }> {
  if (required.previous.identity !== required.record.identity || required.previous.subjectId !== required.record.subjectId || required.previous.eventId !== required.record.eventId) return failure({ code: "conflict", message: "Delivery ID already binds another payload" });
  return { ok: true, value: { acquired: false, record: clone({ value: required.previous }) } };
}
