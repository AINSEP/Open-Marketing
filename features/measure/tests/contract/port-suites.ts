import { describe, it, expect } from "vitest";
import type { ConversionIdentifiersPort, ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionSourceAuthenticationPort, ConversionVerificationPort, MeasureAuditPort, MeasureJobPort, MeasureRepoPort, MeasurementGrantPort, MeasurementShareabilityPort, PlatformReportingPort, TrackedLinkPort } from "../../index.js";
import { context, event, grant, query, resolvedEvent, serviceContext, snapshot, source } from "../fixtures.js";

/** B1 behavioral suite: runs unchanged against memory and real SQL repositories. */
export function MeasureRepoPortSuite(required: { create: () => MeasureRepoPort }) {
  describe("MeasureRepoPort", () => {
    it("accepts and deduplicates one intent/job identity", async () => {
      const port = required.create();
      const first = await port.appendConversion({ source, event });
      const second = await port.appendConversion({ source, event });
      expect(first).toMatchObject({ ok: true, value: { status: "accepted", eventId: event.eventId } });
      expect(second).toMatchObject({ ok: true, value: { status: "duplicate" } });
      if (first.ok && second.ok) expect(second.value.jobId).toBe(first.value.jobId);
    });
    it("canonicalizes identifier ordering and rejects a conflicting duplicate", async () => {
      const port = required.create();
      const input = { ...event, identifierDigests: { a: "a".repeat(64), b: "b".repeat(64) } };
      await port.appendConversion({ source, event: input });
      expect(await port.appendConversion({ source, event: { ...input, identifierDigests: { b: "b".repeat(64), a: "a".repeat(64) } } })).toMatchObject({ ok: true, value: { status: "duplicate" } });
      expect(await port.appendConversion({ source, event: { ...input, subjectId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it.each([
      { definitionId: "purchase" },
      { value: { minorUnits: 200, currency: "USD" } },
      { orderRef: "other-order" },
      { identifierDigests: { click_id: "b".repeat(64) } },
    ])("binds value, order, definition and digests to immutable event identity: %j", async change => {
      const port = required.create();
      const original = { ...event, value: { minorUnits: 100, currency: "USD" }, orderRef: "order-1" };
      expect(await port.appendConversion({ source, event: original })).toMatchObject({ ok: true });
      expect(await port.appendConversion({ source, event: { ...original, ...change } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("isolates workspace and source namespaces", async () => {
      const port = required.create();
      await port.appendConversion({ source, event });
      expect(await port.appendConversion({ source: { ...source, sourceId: "another-source" }, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
      expect(await port.appendConversion({ source: { ...source, scope: { ...source.scope, workspaceId: "another" }, context: undefined }, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
    });
    it("handles simultaneous identical arrivals once", async () => {
      const port = required.create();
      const results = await Promise.all([port.appendConversion({ source, event }), port.appendConversion({ source, event })]);
      expect(results.filter(result => result.ok && result.value.status === "accepted")).toHaveLength(1);
      expect(results.filter(result => result.ok && result.value.status === "duplicate")).toHaveLength(1);
    });
    it("rejects malformed conversion schemas", async () => {
      const port = required.create();
      expect(await port.appendConversion({ source, event: { ...event, occurredAt: -1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.appendConversion({ source, event: { ...event, identifierDigests: Object.fromEntries(Array.from({ length: 17 }, (_, index) => ["key" + index, "a".repeat(64)])) } })).toMatchObject({ ok: false });
      const tainted = { ...event, identifiers: resolvedEvent.identifiers };
      expect(await port.appendConversion({ source, event: tainted })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("rejects contradictory source context before allocating a job", async () => {
      const port = required.create();
      const forged = { ...source, context: { ...context, scope: { ...context.scope, workspaceId: "forged" } } };
      expect(await port.appendConversion({ source: forged, event })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await port.appendConversion({ source, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
    });
    it("detaches accepted event and snapshot data from caller mutation", async () => {
      const port = required.create();
      const input = structuredClone({ source, event });
      await port.appendConversion(input);
      Object.assign(input.event.identifierDigests, { click_id: "mutated" });
      expect(await port.appendConversion({ source, event })).toMatchObject({ ok: true, value: { status: "duplicate" } });
      const observation = structuredClone(snapshot);
      const appended = await port.appendSnapshot({ context, snapshot: observation });
      expect(appended.ok).toBe(true);
      if (appended.ok) Object.assign(appended.value.spend, { minorUnits: 900 });
      observation.spend.minorUnits = 900;
      expect(await port.appendSnapshot({ context, snapshot })).toEqual({ ok: true, value: snapshot });
    });
    it("preserves immutable snapshot history and restatement lineage", async () => {
      const port = required.create();
      expect(await port.appendSnapshot({ context, snapshot })).toMatchObject({ ok: true });
      expect(await port.appendSnapshot({ context, snapshot: { ...snapshot, spend: { ...snapshot.spend, minorUnits: 999 } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.appendSnapshot({ context, snapshot: { ...snapshot, snapshotId: "restatement", restatementOf: snapshot.snapshotId, retrievedAt: 400, spend: { ...snapshot.spend, minorUnits: 700 } } })).toMatchObject({ ok: true });
      expect(await port.appendSnapshot({ context, snapshot: { ...snapshot, snapshotId: "orphan", restatementOf: "absent" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("counts only declared mapped OM events in [start,end), with scope isolation", async () => {
      const port = required.create();
      for (const [index, time] of [99, 100, 199, 200].entries()) {
        const eventId = "event-" + index;
        await port.appendConversion({ source, event: { ...event, eventId, subjectId: "subject-" + index, occurredAt: time } });
        await port.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "result-" + index, eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } });
      }
      expect(await port.readAttribution!({ context, query })).toEqual({ ok: true, value: { conversions: 2, modelVersion: query.attributionModel, watermark: 199 } });
      expect(await port.readAttribution!({ context: { ...context, scope: { ...context.scope, workspaceId: "other" } }, query })).toMatchObject({ ok: true, value: { conversions: 0 } });
      expect(await port.readAttribution!({ context, query: { ...query, attributionModel: "other_model" } })).toMatchObject({ ok: true, value: { conversions: 0 } });
    });
    it("acquires a customer once across sources and repeats, independently per definition", async () => {
      const port = required.create();
      const inputs = [
        { source, event },
        { source: { ...source, sourceId: "operator" }, event },
        { source, event: { ...event, eventId: "signup-repeat", occurredAt: 199 } },
        { source, event: { ...event, eventId: "trial-1", definitionId: "trial", occurredAt: 150 } },
      ];
      for (const [index, input] of inputs.entries()) {
        expect(await port.appendConversion(input)).toMatchObject({ ok: true });
        expect(await port.appendAttribution!({ context, sourceId: input.source.sourceId, result: { resultId: "acquisition-" + index, eventId: input.event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
      }
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 1, watermark: 100 } });
      expect(await port.readAttribution!({ context, query: { ...query, definitionId: "trial" } })).toMatchObject({ ok: true, value: { conversions: 1, watermark: 150 } });
    });
    it.each(["period", "account", "model", "unmapped", "no-attribution"])("selects the first outcome before the %s filter", async excludedBy => {
      const port = required.create();
      const first = { ...event, eventId: "first", occurredAt: excludedBy === "period" ? 99 : 100 };
      expect(await port.appendConversion({ source, event: first })).toMatchObject({ ok: true });
      if (excludedBy !== "no-attribution") {
        expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "first-result", eventId: first.eventId, modelVersion: excludedBy === "model" ? "other-model" : query.attributionModel, accountId: excludedBy === "account" ? "other-account" : query.accountId, campaignId: excludedBy === "unmapped" ? null : "campaign" } })).toMatchObject({ ok: true });
      }
      const later = { ...event, eventId: "later", occurredAt: 150 };
      expect(await port.appendConversion({ source, event: later })).toMatchObject({ ok: true });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "later-result", eventId: later.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 0, watermark: query.window.start } });
    });
    it("restates acquisition when an earlier verified outcome arrives late", async () => {
      const port = required.create();
      expect(await port.appendConversion({ source, event })).toMatchObject({ ok: true });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "initial", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 1 } });
      expect(await port.appendConversion({ source, event: { ...event, eventId: "earlier", occurredAt: 99 } })).toMatchObject({ ok: true });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 0 } });
    });
    it.each([
      { firstId: "a", laterId: "z", firstSource: "z", laterSource: "a" },
      { firstId: "same", laterId: "same", firstSource: "a", laterSource: "z" },
      { firstId: "\uE000", laterId: "\u{10000}", firstSource: "a", laterSource: "a" },
    ])("breaks time ties by event ID then source ID in binary order: %j", async tie => {
      const port = required.create();
      const laterSource = { ...source, sourceId: tie.laterSource };
      const later = { ...event, eventId: tie.laterId };
      expect(await port.appendConversion({ source: laterSource, event: later })).toMatchObject({ ok: true });
      expect(await port.appendAttribution!({ context, sourceId: laterSource.sourceId, result: { resultId: "mapped-later", eventId: later.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" } })).toMatchObject({ ok: true });
      expect(await port.appendConversion({ source: { ...source, sourceId: tie.firstSource }, event: { ...event, eventId: tie.firstId } })).toMatchObject({ ok: true });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 0 } });
    });
    it("refuses attribution before verification or immutable model corrections", async () => {
      const port = required.create();
      const result = { resultId: "r", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" };
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      await port.appendConversion({ source, event });
      await port.appendAttribution!({ context, sourceId: source.sourceId, result });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { ...result, accountId: query.accountId, campaignId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects malformed attribution without inventing success", async () => {
      const port = required.create();
      await port.appendConversion({ source, event });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { resultId: "bad", eventId: event.eventId, accountId: "", modelVersion: query.attributionModel, campaignId: "campaign" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 0 } });
    });
    it("binds result IDs and CAC denominators to one account", async () => {
      const port = required.create();
      const result = { resultId: "result-one", eventId: event.eventId, modelVersion: query.attributionModel, accountId: query.accountId, campaignId: "campaign" };
      await port.appendConversion({ source, event });
      await port.appendAttribution!({ context, sourceId: source.sourceId, result });
      await port.appendConversion({ source, event: { ...event, eventId: "second", subjectId: "second-subject" } });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { ...result, eventId: "second" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.appendAttribution!({ context, sourceId: source.sourceId, result: { ...result, resultId: "result-two", eventId: "second", accountId: "another-account" } })).toMatchObject({ ok: true });
      expect(await port.readAttribution!({ context, query })).toMatchObject({ ok: true, value: { conversions: 1 } });
      expect(await port.readAttribution!({ context, query: { ...query, accountId: "another-account" } })).toMatchObject({ ok: true, value: { conversions: 1 } });
    });
    it.each(["accountId", "timezone", "attributionWindow"] as const)("rejects restatement dimension drift: %s", async field => {
      const port = required.create();
      await port.appendSnapshot({ context, snapshot });
      expect(await port.appendSnapshot({ context, snapshot: { ...snapshot, snapshotId: "restated", restatementOf: snapshot.snapshotId, [field]: "different" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
}
export function MeasurementShareabilityPortSuite(required: { create: () => MeasurementShareabilityPort }) {
  describe("MeasurementShareabilityPort", () => {
    it("admits exact consent and denies a changed purpose/destination/identifier", async () => {
      const port = required.create();
      expect(await port.assess({ context, event })).toMatchObject({ ok: true, value: { allowed: true } });
      expect(await port.assess({ context, event: { ...event, purpose: "audience_activation" } })).toMatchObject({ ok: true, value: { allowed: false } });
      expect(await port.assess({ context, event: { ...event, destination: "other-account" } })).toMatchObject({ ok: true, value: { allowed: false } });
      expect(await port.assess({ context, event: { ...event, identifierDigests: { email_hash: "a".repeat(64) } } })).toMatchObject({ ok: true, value: { allowed: false } });
    });
  });
}
export function ConversionDeliveryPortSuite(required: { create: () => ConversionDeliveryPort | Promise<ConversionDeliveryPort> }) {
  describe("ConversionDeliveryPort", () => {
    it("uses stable delivery identity and rejects payload conflicts", async () => {
      const port = await required.create();
      const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "delivery-1" };
      expect(await port.deliver(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
      expect(await port.deliver(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
      expect(await port.deliver({ ...input, event: { ...resolvedEvent, subjectId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("requires delivery identity", async () => {
      expect(await (await required.create()).deliver({ context: serviceContext, event: resolvedEvent, grant })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("rejects changed account/connection binding under one delivery ID", async () => {
      const port = await required.create();
      const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "delivery-binding" };
      await port.deliver(input);
      expect(await port.deliver({ ...input, grant: { ...grant, accountId: "different" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.reconcile!({ ...input, grant: { ...grant, connectionId: "different" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("validates reconciliation payloads before interpreting evidence", async () => {
      const port = await required.create();
      const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "delivery-schema" };
      await port.deliver(input);
      expect(await port.reconcile!({ ...input, event: { ...resolvedEvent, occurredAt: -1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.reconcile!({ ...input, context: { ...serviceContext, traceId: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("keeps delivery identity stable when only transient identifiers or traces change", async () => {
      const port = await required.create();
      const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "transient" };
      expect(await port.deliver(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
      expect(await port.deliver({ ...input, context: { ...serviceContext, traceId: "retry" }, event: { ...resolvedEvent, identifiers: { click_id: "current-click" } } })).toMatchObject({ ok: true, value: { status: "delivered" } });
      expect(await port.reconcile!({ ...input, event: { ...resolvedEvent, identifierDigests: { click_id: "b".repeat(64) } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects extra or missing identifier keys and oversized maps", async () => {
      const port = await required.create();
      const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "key-mismatch" };
      expect(await port.deliver({ ...input, event: { ...resolvedEvent, identifiers: {} } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await port.deliver({ ...input, event: { ...resolvedEvent, identifiers: { ...resolvedEvent.identifiers, email: "extra" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await port.deliver({ ...input, event: { ...resolvedEvent, identifiers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["id" + i, "value"])) } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
export function PlatformReportingPortSuite(required: { create: () => PlatformReportingPort | Promise<PlatformReportingPort> }) {
  describe("PlatformReportingPort", () => {
    it("returns a schema-bound observation without platform conversion counters", async () => {
      expect(await (await required.create()).snapshot({ context, query })).toEqual({ ok: true, value: snapshot });
    });
    it("rejects malformed query boundaries", async () => {
      expect(await (await required.create()).snapshot({ context, query: { ...query, window: { start: 200, end: 100 } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
export function MeasureJobPortSuite(required: { create: () => MeasureJobPort }) {
  describe("MeasureJobPort", () => {
    it("deduplicates and explicitly rejects conflicting payloads", async () => {
      const port = required.create();
      const first = await port.enqueue({ source, event });
      expect(first.ok).toBe(true);
      expect(await port.enqueue({ source, event })).toEqual(first);
      expect(await port.enqueue({ source, event: { ...event, occurredAt: 101 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
}
export function TrackedLinkPortSuite(required: { create: () => TrackedLinkPort }) {
  describe("TrackedLinkPort", () => {
    it("preserves admitted click IDs and UTM; scoped redirect matches", async () => {
      const port = required.create();
      const created = await port.create({ context, request: { destinationUrl: "https://shop.example/signup?click_id=click-1", campaignId: "campaign", utm: { utm_campaign: "readable-name", utm_source: "search" } } });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.campaignId).toBe("campaign");
      const destination = new URL(created.value.destinationUrl);
      expect(destination.searchParams.get("click_id")).toBe("click-1");
      expect(destination.searchParams.get("utm_source")).toBe("search");
      expect(destination.searchParams.get("utm_campaign")).toBe("readable-name");
      expect(await port.resolve!({ context, linkId: created.value.linkId })).toEqual(created);
      expect(await port.resolve!({ context: { ...context, scope: { ...context.scope, workspaceId: "other" } }, linkId: created.value.linkId })).toMatchObject({ ok: false });
    });
    it.each(["javascript:alert(1)", "https://evil.example/", "https://user:pass@shop.example/", "https://shop.example/?email=person", "https://shop.example/#subject", "https://shop.example/?click_id=a&click_id=b", "not a URL"])("denies unsafe destination %s", async destinationUrl => {
      expect(await required.create().create({ context, request: { destinationUrl, campaignId: "campaign", utm: {} } })).toMatchObject({ ok: false });
    });
  });
}
export function MeasureAuditPortSuite(required: { create: () => MeasureAuditPort }) {
  describe("MeasureAuditPort", () => {
    it("appends repeated operation observations", async () => {
      const port = required.create();
      expect(await port.record({ context, operationId: "delivery-1", outcome: "dispatch_pending" })).toEqual({ ok: true, value: undefined });
      expect(await port.record({ context, operationId: "delivery-1", outcome: "dispatch_delivered" })).toEqual({ ok: true, value: undefined });
    });
    it("rejects unbounded or malformed audit evidence", async () => {
      const port = required.create();
      expect(await port.record({ context, operationId: "", outcome: "pending" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.record({ context, operationId: "delivery", outcome: "x".repeat(257) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
export function ConversionSourceAuthenticationPortSuite(required: { create: () => ConversionSourceAuthenticationPort }) {
  describe("ConversionSourceAuthenticationPort", () => {
    it("authenticates current source scope/revision only", async () => {
      const port = required.create();
      expect(await port.verify({ source })).toMatchObject({ ok: true, value: { authenticated: true } });
      expect(await port.verify({ source: { ...source, authenticationRevision: 2 } })).toMatchObject({ ok: true, value: { authenticated: false } });
      expect(await port.verify({ source: { ...source, scope: { ...source.scope, workspaceId: "other" } } })).toMatchObject({ ok: true, value: { authenticated: false } });
    });
  });
}
export function MeasurementGrantPortSuite(required: { create: () => MeasurementGrantPort }) {
  describe("MeasurementGrantPort", () => {
    it("reads only a scoped measurement grant", async () => {
      const port = required.create();
      expect(await port.current({ context: serviceContext, grantId: grant.grantId })).toEqual({ ok: true, value: grant });
      expect(await port.current({ context: { ...serviceContext, scope: { ...serviceContext.scope, workspaceId: "other" } }, grantId: grant.grantId })).toMatchObject({ ok: false });
    });
  });
}
export function ConversionDeliveryStatePortSuite(required: { create: () => ConversionDeliveryStatePort }) {
  describe("ConversionDeliveryStatePort", () => {
    it("claims once, preserves unknown evidence and cannot regress delivered", async () => {
      const port = required.create();
      const record = { deliveryId: "delivery-1", subjectId: event.subjectId, eventId: event.eventId, identity: "a".repeat(64), status: "dispatching" as const, recordedAt: 300 };
      expect(await port.begin({ context: serviceContext, record })).toMatchObject({ ok: true, value: { acquired: true } });
      expect(await port.begin({ context: serviceContext, record })).toMatchObject({ ok: true, value: { acquired: false } });
      expect(await port.begin({ context: serviceContext, record: { ...record, identity: "b".repeat(64) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.append({ context: serviceContext, record: { ...record, status: "unknown", recordedAt: 301 } })).toMatchObject({ ok: true });
      expect(await port.append({ context: serviceContext, record: { ...record, status: "delivered", recordedAt: 302 } })).toMatchObject({ ok: true });
      expect(await port.append({ context: serviceContext, record: { ...record, status: "unknown", recordedAt: 303 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects regressing timestamps and cross-workspace transitions", async () => {
      const port = required.create();
      const record = { deliveryId: "ordered", subjectId: event.subjectId, eventId: event.eventId, identity: "a".repeat(64), status: "dispatching" as const, recordedAt: 300 };
      await port.begin({ context: serviceContext, record });
      expect(await port.append({ context: serviceContext, record: { ...record, status: "unknown", recordedAt: 299 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.append({ context: { ...serviceContext, scope: { ...serviceContext.scope, workspaceId: "other" } }, record: { ...record, status: "delivered" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it.each(["subjectId", "eventId"] as const)("preserves %s through claims and ledger versions", async field => {
      const port = required.create();
      const record = { deliveryId: "identity-fields", subjectId: event.subjectId, eventId: event.eventId, identity: "a".repeat(64), status: "dispatching" as const, recordedAt: 300 };
      expect(await port.begin({ context: serviceContext, record })).toMatchObject({ ok: true, value: { acquired: true } });
      expect(await port.begin({ context: serviceContext, record: { ...record, [field]: "changed" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.append({ context: serviceContext, record: { ...record, status: "delivered", [field]: "changed" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("rejects non-digest identity and raw identifier fields", async () => {
      const port = required.create();
      const record = { deliveryId: "bad-identity", subjectId: event.subjectId, eventId: event.eventId, identity: "raw-click", status: "dispatching" as const, recordedAt: 300 };
      expect(await port.begin({ context: serviceContext, record })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const taintedRecord = { ...record, identity: "a".repeat(64), identifiers: { click_id: "raw-click" } };
      expect(await port.begin({ context: serviceContext, record: taintedRecord })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}

/** Caller-owned contacts adapters must reuse this suite when implemented. */
export function ConversionIdentifiersPortSuite(required: { create: () => ConversionIdentifiersPort }) {
  describe("ConversionIdentifiersPort", () => {
    it("returns current subject evidence, detached from caller mutation", async () => {
      const port = required.create();
      const input = { context: serviceContext, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose };
      const outcome = await port.identifiersFor(input);
      expect(outcome).toEqual({ ok: true, value: { subjectId: event.subjectId, identifierDigests: event.identifierDigests, identifiers: resolvedEvent.identifiers } });
      if (outcome.ok) Object.assign(outcome.value.identifiers, { click_id: "mutated" });
      expect(await port.identifiersFor(input)).toEqual({ ok: true, value: { subjectId: event.subjectId, identifierDigests: event.identifierDigests, identifiers: resolvedEvent.identifiers } });
    });
    it("denies absent subjects, cross-scope requests and mismatched purpose/destination", async () => {
      const port = required.create();
      const input = { context: serviceContext, subjectId: event.subjectId, destination: event.destination, purpose: event.purpose };
      for (const changed of [
        { subjectId: "missing" }, { destination: "other" }, { purpose: "other" },
        { context: { ...serviceContext, scope: { ...serviceContext.scope, workspaceId: "other" } } },
      ]) expect(await port.identifiersFor({ ...input, ...changed })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await port.identifiersFor({ ...input, subjectId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}

/** B1: exact committed event verification, including conflicting IDs and scope. */
export function ConversionVerificationPortSuite(required: { create: () => Promise<ConversionVerificationPort> | ConversionVerificationPort }) {
  describe("ConversionVerificationPort", () => {
    it("verifies only the committed canonical event in its scope", async () => {
      const port = await required.create();
      expect(await port.verify({ context: serviceContext, event })).toEqual({ ok: true, value: { verified: true } });
      expect(await port.verify({ context: serviceContext, event: { ...event, subjectId: "fabricated" } })).toEqual({ ok: true, value: { verified: false } });
      expect(await port.verify({ context: { ...serviceContext, scope: { ...serviceContext.scope, workspaceId: "other" } }, event })).toEqual({ ok: true, value: { verified: false } });
      expect(await port.verify({ context: serviceContext, event: { ...event, eventId: "absent" } })).toEqual({ ok: true, value: { verified: false } });
    });
    it("rejects malformed input before inbox access", async () => {
      const port = await required.create();
      expect(await port.verify({ context: serviceContext, event: { ...event, occurredAt: -1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
