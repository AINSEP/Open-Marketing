import { Buffer } from "node:buffer";
import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { IdPort, Outcome, Scope } from "@open-marketing/contracts";
import type { MeasureRepoPort, MeasurePrivacyPort } from "../ports.js";
import type { CacQuery, AttributionResult, ConversionInput, ConversionReceipt, PlatformMetricSnapshot, VerifiedConversionSource } from "../types.js";
import { snapshotIdentity, validateLineage } from "../reporting/snapshot-rules.js";
import { attributionInputSchema, clone, conversionKey, eventIdentity, failure, nextId, parseSourceEvent, querySchema, scopeKey, snapshotSchema, storageLimit } from "../rules.js";

type StoredEvent = { source: VerifiedConversionSource; event: ConversionInput; receipt: ConversionReceipt; identity: string };
type AttributionEntry = { scope: Scope; sourceId: string; result: AttributionResult };
/** Inspection is test-only; production uses the jobs-owned outbox, not a memory store. */
export interface MemoryMeasureRepo extends MeasureRepoPort, MeasurePrivacyPort {
  inspect(required: { scope: Scope }): { events: readonly ConversionInput[]; jobs: readonly ConversionReceipt[]; snapshots: readonly PlatformMetricSnapshot[] };
}
/** Isolated bounded inbox/outbox double. One stored record holds both intent and
 * job receipt, so there is no intermediate state or asynchronous commit gap.
 * @example createMemoryMeasureRepo({ ids })
 * @complexity O(1) append/dedup; acquisition selection O(n+a), bounded by maxRecords. */
export function createMemoryMeasureRepo(required: { ids?: IdPort; maxRecords?: number }): MemoryMeasureRepo {
  const events = new Map<string, StoredEvent>();
  const snapshots = new Map<string, { scope: Scope; snapshot: PlatformMetricSnapshot }>();
  const attributions = new Map<string, AttributionEntry>();
  const limit = storageLimit(required);
  const resultIds = new Map<string, string>();
  let sequence = 0;
  return {
    async purgeSubject(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const subjectId = parseBoundary({ schema: idSchema, input: input.subjectId });
      if (!subjectId.ok) return subjectId;
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Purge cancelled" });
      const tenant = scopeKey({ scope: context.value.scope });
      for (const entry of events.values()) {
        if (scopeKey({ scope: entry.source.scope }) !== tenant || entry.event.subjectId !== subjectId.value) continue;
        const { orderRef, ...retained } = entry.event;
        void orderRef;
        entry.event = retained;
      }
      return { ok: true, value: undefined };
    },
    async appendConversion(input) {
      const parsed = parseSourceEvent({ input });
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      const key = conversionKey(value);
      const identity = eventIdentity({ event: value.event });
      const existing = events.get(key);
      if (existing) return duplicate({ existing, identity });
      if (events.size >= limit) return failure({ code: "limit_exceeded", message: "Conversion storage limit" });
      const id = nextId({ ids: required.ids, fallback: "conversion-job-" + ++sequence });
      if (!id.ok) return id;
      const receipt: ConversionReceipt = { eventId: value.event.eventId, status: "accepted", jobId: id.value };
      events.set(key, clone({ value: { ...value, identity, receipt } }));
      return { ok: true, value: clone({ value: receipt }) };
    },
    async appendSnapshot(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const parsed = parseBoundary({ schema: snapshotSchema, input: input.snapshot });
      if (!parsed.ok) return parsed;
      const tenant = scopeKey({ scope: input.context.scope });
      const key = JSON.stringify([tenant, parsed.value.snapshotId]);
      const existing = snapshots.get(key);
      if (existing) return snapshotDuplicate({ existing: existing.snapshot, snapshot: parsed.value });
      if (snapshots.size >= limit) return failure({ code: "limit_exceeded", message: "Snapshot storage limit" });
      const lineage = checkLineage({ snapshots, tenant, snapshot: parsed.value });
      if (!lineage.ok) return lineage;
      snapshots.set(key, clone({ value: { scope: input.context.scope, snapshot: parsed.value } }));
      return parsed;
    },
    async appendAttribution(input) {
      const parsed = parseBoundary({ schema: attributionInputSchema, input });
      if (!parsed.ok) return parsed;
      input = parsed.value;
      const key = JSON.stringify([scopeKey({ scope: input.context.scope }), input.sourceId, input.result.eventId]);
      const event = events.get(JSON.stringify([scopeKey({ scope: input.context.scope }), input.sourceId, input.result.eventId]));
      if (!event) return failure({ code: "invalid_input", message: "Attribution requires a verified conversion" });
      const modelKey = JSON.stringify([key, input.result.modelVersion]);
      const existing = attributions.get(modelKey);
      if (existing) return attributionDuplicate({ existing: existing.result, result: input.result });
      const resultIdKey = JSON.stringify([scopeKey({ scope: input.context.scope }), input.result.resultId]);
      if (resultIds.has(resultIdKey)) return failure({ code: "conflict", message: "Attribution result ID already binds another event or model" });
      if (attributions.size >= limit) return failure({ code: "limit_exceeded", message: "Attribution storage limit" });
      resultIds.set(resultIdKey, modelKey);
      attributions.set(modelKey, clone({ value: { scope: input.context.scope, sourceId: input.sourceId, result: input.result } }));
      return { ok: true, value: input.result };
    },
    async readAttribution(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const query = parseBoundary({ schema: querySchema, input: input.query });
      if (!query.ok) return query;
      const tenant = scopeKey({ scope: context.value.scope });
      const times = acquisitionTimes({ events, attributions, tenant, query: query.value });
      return { ok: true, value: { conversions: times.length, modelVersion: query.value.attributionModel, watermark: times.reduce((watermark, time) => Math.max(watermark, time), query.value.window.start) } };
    },
    inspect(input) {
      const tenant = scopeKey({ scope: input.scope });
      const selected = [...events.values()].filter(entry => scopeKey({ scope: entry.source.scope }) === tenant);
      const observations = [...snapshots.values()].filter(entry => scopeKey({ scope: entry.scope }) === tenant).map(entry => entry.snapshot);
      return clone({ value: { events: selected.map(entry => entry.event), jobs: selected.map(entry => entry.receipt), snapshots: observations } });
    },
  };
}
function duplicate(required: { existing: StoredEvent; identity: string }): Outcome<ConversionReceipt> {
  if (required.existing.identity !== required.identity) return failure({ code: "conflict", message: "Conflicting duplicate conversion" });
  return { ok: true, value: { ...required.existing.receipt, status: "duplicate" } };
}
function snapshotDuplicate(required: { existing: PlatformMetricSnapshot; snapshot: PlatformMetricSnapshot }): Outcome<PlatformMetricSnapshot> {
  if (snapshotIdentity({ snapshot: required.existing }) !== snapshotIdentity({ snapshot: required.snapshot })) return failure({ code: "conflict", message: "Snapshot ID is immutable" });
  return { ok: true, value: clone({ value: required.existing }) };
}
function checkLineage(required: { snapshots: Map<string, { scope: Scope; snapshot: PlatformMetricSnapshot }>; tenant: string; snapshot: PlatformMetricSnapshot }): Outcome<void> {
  if (!required.snapshot.restatementOf) return { ok: true, value: undefined };
  const parent = required.snapshots.get(JSON.stringify([required.tenant, required.snapshot.restatementOf]));
  if (!parent) return failure({ code: "invalid_input", message: "Restatement parent is missing" });
  return validateLineage({ parent: parent.snapshot, snapshot: required.snapshot });
}
function attributionDuplicate(required: { existing: AttributionResult; result: AttributionResult }): Outcome<AttributionResult> {
  const left = required.existing;
  const right = required.result;
  if (left.resultId !== right.resultId || left.campaignId !== right.campaignId || left.accountId !== right.accountId) return failure({ code: "conflict", message: "Attribution is immutable for a declared model" });
  return { ok: true, value: clone({ value: left }) };
}

/** Select the first verified outcome before account/model/period filters, so a later
 * mapped event cannot acquire an existing customer again. No acquisition table.
 * @complexity O(n+a) time/O(n+a) space, bounded by the memory repo record cap. */
function acquisitionTimes(required: { events: Map<string, StoredEvent>; attributions: Map<string, AttributionEntry>; tenant: string; query: CacQuery }): number[] {
  const first = new Map<string, StoredEvent>();
  for (const entry of required.events.values()) {
    if (scopeKey({ scope: entry.source.scope }) !== required.tenant || entry.event.definitionId !== required.query.definitionId) continue;
    const previous = first.get(entry.event.subjectId);
    if (!previous || earlierAcquisition({ left: entry, right: previous })) first.set(entry.event.subjectId, entry);
  }
  const mapped = new Set([...required.attributions.values()]
    .filter(entry => scopeKey({ scope: entry.scope }) === required.tenant && entry.result.modelVersion === required.query.attributionModel && entry.result.accountId === required.query.accountId && entry.result.campaignId !== null)
    .map(entry => JSON.stringify([entry.sourceId, entry.result.eventId])));
  return [...first.values()]
    .filter(entry => mapped.has(JSON.stringify([entry.source.sourceId, entry.event.eventId])) && entry.event.occurredAt >= required.query.window.start && entry.event.occurredAt < required.query.window.end)
    .map(entry => entry.event.occurredAt);
}
/** Fixed (occurredAt,eventId,sourceId) order uses UTF-8 bytes like SQLite BINARY,
 * including supplementary Unicode IDs. @complexity O(l) for bounded ID lengths. */
function earlierAcquisition(required: { left: StoredEvent; right: StoredEvent }): boolean {
  const left = required.left;
  const right = required.right;
  if (left.event.occurredAt !== right.event.occurredAt) return left.event.occurredAt < right.event.occurredAt;
  if (left.event.eventId !== right.event.eventId) return Buffer.compare(Buffer.from(left.event.eventId), Buffer.from(right.event.eventId)) < 0;
  return Buffer.compare(Buffer.from(left.source.sourceId), Buffer.from(right.source.sourceId)) < 0;
}
