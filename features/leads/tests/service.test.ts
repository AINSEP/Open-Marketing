import { describe, expect, it } from "vitest";
import { createLeadsService, createMemoryLeadsRepo } from "../index.js";
import { attribution, context, runtime, value } from "./fixtures.js";

function setup() { const fixture = runtime(); const repo = createMemoryLeadsRepo({}); return { ...fixture, repo, service: createLeadsService({ ...fixture, repo }) }; }
const intake = { context, subjectId: "subject", source: { kind: "form" as const, ref: "submission" }, occurredAt: 200, attribution };

describe("lead lifecycle service", () => {
  it("accepts each intake source without sharing consent and preserves creation/occurrence time", async () => {
    const { service } = setup();
    for (const kind of ["form", "call", "booking", "manual"] as const) {
      const lead = value(await service.capture({ ...intake, source: { kind, ref: "same-ref" } }));
      expect(lead).toMatchObject({ subjectId: "subject", stage: "new", revision: 1, occurredAt: 200, createdAt: 1000, attribution });
    }
    expect(value(await service.list({ context, query: { page: { limit: 100 } } })).items).toHaveLength(4);
  });
  it("freezes original evidence on retry, accepts the exact 30-day boundary and drops stale/future evidence", async () => {
    const { service, time } = setup();
    const occurredAt = 30 * 86400000;
    const original = value(await service.capture({ ...intake, occurredAt, attribution: { ...attribution, touchedAt: 0 } }));
    expect(original.attribution.touchedAt).toBe(0);
    time.now = 9000;
    expect(value(await service.capture({ ...intake, occurredAt, attribution: { ...attribution, touchedAt: occurredAt } }))).toEqual(original);
    for (const touchedAt of [0, occurredAt + 2]) {
      const lead = value(await service.capture({ ...intake, occurredAt: occurredAt + 1, source: { kind: "manual", ref: String(touchedAt) }, attribution: { ...attribution, touchedAt } }));
      expect(lead.attribution).toEqual({ campaign: null, touchId: null, touchedAt: null, modelVersion: "last_paid_touch_30d.v1" });
    }
  });
  it("allows corrections across all stages, links spam and keeps retries idempotent", async () => {
    const { service } = setup();
    let lead = value(await service.capture(intake));
    for (const to of ["qualified", "won", "disqualified", "spam", "new"] as const) {
      const input = { context, leadId: lead.leadId, to, expectedRevision: lead.revision, changeId: "change-" + to };
      lead = value(await service.setStage(input));
      expect(value(await service.setStage(input))).toEqual(lead);
      expect(lead.attribution).toEqual(attribution);
    }
    const events = value(await service.history({ context, leadId: lead.leadId, page: { limit: 100 } })).items;
    expect(events).toHaveLength(6);
    expect(events[4]).toMatchObject({ to: "spam", retractsEventId: "change-disqualified", actor: context.principal, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    expect(events[5].retractsEventId).toBeNull();
  });
  it("rejects missing leads, invalid attribution structure and cancelled input without writes", async () => {
    const { service } = setup();
    expect(await service.setStage({ context, leadId: "missing", to: "won", expectedRevision: 1, changeId: "change" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await service.capture({ ...intake, attribution: { ...attribution, campaign: null } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await service.capture(intake, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(value(await service.list({ context, query: { page: { limit: 100 } } })).items).toEqual([]);
  });
});
