import { callContextSchema, parseBoundary } from "@open-marketing/contracts";
import type { IdPort, Outcome, Scope } from "@open-marketing/contracts";
import type { MeasureRepoPort } from "../ports.js";
import type { AttributionResult, ConversionInput, ConversionReceipt, PlatformMetricSnapshot, VerifiedConversionSource } from "../types.js";
import { snapshotIdentity, validateLineage } from "../reporting/snapshot-rules.js";
import { attributionInputSchema, clone, conversionKey, eventIdentity, failure, nextId, parseSourceEvent, querySchema, scopeKey, snapshotSchema, storageLimit } from "../rules.js";

type StoredEvent = { source: VerifiedConversionSource; event: ConversionInput; receipt: ConversionReceipt; identity: string };
type AttributionEntry = { scope: Scope; sourceId: string; result: AttributionResult };
/** Inspection is test-only; production uses the jobs-owned outbox, not a memory store. */
export interface MemoryMeasureRepo extends MeasureRepoPort {
  inspect(required: { scope: Scope }): { events: readonly ConversionInput[]; jobs: readonly ConversionReceipt[]; snapshots: readonly PlatformMetricSnapshot[] };
}
/** Isolated bounded inbox/outbox double. One stored record holds both intent and
 * job receipt, so there is no intermediate state or asynchronous commit gap.
 * @example createMemoryMeasureRepo({ ids })
 * @complexity O(1) append/dedup; attribution scan O(n+a), bounded by maxRecords. */
export function createMemoryMeasureRepo(required: { ids?: IdPort; maxRecords?: number }): MemoryMeasureRepo {
  const events = new Map<string, StoredEvent>();
  const snapshots = new Map<string, { scope: Scope; snapshot: PlatformMetricSnapshot }>();
  const attributions = new Map<string, AttributionEntry>();
  const limit = storageLimit(required);
  const resultIds = new Map<string, string>();
  let sequence = 0;
  return {
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
      const selected = [...attributions.values()].filter(entry => scopeKey({ scope: entry.scope }) === tenant && entry.result.modelVersion === query.value.attributionModel && entry.result.accountId === query.value.accountId && entry.result.campaignId !== null);
      const times = selected.map(entry => events.get(JSON.stringify([tenant, entry.sourceId, entry.result.eventId]))?.event.occurredAt).filter((time): time is number => time !== undefined && time >= query.value.window.start && time < query.value.window.end);
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
