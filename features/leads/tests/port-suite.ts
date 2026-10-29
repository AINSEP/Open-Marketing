import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext } from "@open-marketing/contracts";
import type { LeadAttribution, LeadsRepoPort } from "../index.js";
import { attribution, context, otherOwner, otherWorkspace, record, stage, value } from "./fixtures.js";

/** One behavior contract for memory and SQL; failures assert persisted state, not only errors. */
export function leadsRepoSuite(required: { name: string; create: () => { repo: LeadsRepoPort; close?: () => void } }): void {
  describe(required.name, () => {
    let fixture: ReturnType<typeof required.create>;
    beforeEach(() => { fixture = required.create(); });
    afterEach(() => fixture.close?.());
    it("captures projection + initial evidence and isolates both scope dimensions", async () => {
      const lead = value(await fixture.repo.capture(record()));
      expect(lead).toEqual(record().lead);
      expect(value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 100 } })).items).toEqual([record().event]);
      for (const ctx of [otherWorkspace, otherOwner]) {
        expect(value(await fixture.repo.get({ context: ctx, leadId: lead.leadId }))).toBeNull();
        expect(value(await fixture.repo.history({ context: ctx, leadId: lead.leadId, page: { limit: 100 } })).items).toEqual([]);
        expect(value(await fixture.repo.capture(record({ context: ctx })))).toEqual(record({ context: ctx }).lead);
      }
    });
    it("replays scoped sources without replacing IDs, time or frozen attribution", async () => {
      const original = value(await fixture.repo.capture(record()));
      const replay = record({ lead: { leadId: "retry", lastEventId: "retry-event", createdAt: 9000, attribution: { ...attribution, touchId: "late-touch" } } });
      expect(value(await fixture.repo.capture(replay))).toEqual(original);
      expect(await fixture.repo.capture(record({ lead: { subjectId: "different" } }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.capture(record({ lead: { occurredAt: 201 } }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value(await fixture.repo.history({ context, leadId: original.leadId, page: { limit: 100 } })).items).toHaveLength(1);
    });
    it("lets only one competing revision append and preserves stable change retries", async () => {
      const lead = value(await fixture.repo.capture(record()));
      const first = stage({ lead });
      const results = await Promise.all([fixture.repo.appendStage(first), fixture.repo.appendStage(stage({ lead, to: "won", changeId: "competitor" }))]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.find(result => !result.ok)).toMatchObject({ error: { code: "conflict" } });
      const qualified = value(results[0]);
      const won = value(await fixture.repo.appendStage(stage({ lead: qualified, to: "won", changeId: "won" })));
      expect(value(await fixture.repo.appendStage(first))).toEqual(won);
      expect(await fixture.repo.appendStage({ ...first, event: { ...first.event, to: "disqualified" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 100 } })).items.map(event => event.to)).toEqual(["new", "qualified", "won"]);
    });
    it("makes simultaneous source retries return one lead and one initial event", async () => {
      const replay = record({ lead: { leadId: "retry", lastEventId: "retry-event" } });
      const results = await Promise.all([fixture.repo.capture(record()), fixture.repo.capture(replay)]);
      expect(results.map(result => value(result))).toEqual([record().lead, record().lead]);
      expect(value(await fixture.repo.list({ context, query: { page: { limit: 100 } } })).items).toHaveLength(1);
      expect(value(await fixture.repo.history({ context, leadId: "lead-1", page: { limit: 100 } })).items).toHaveLength(1);
    });
    it("links spam to its predecessor and appends a correction without changing history", async () => {
      const lead = value(await fixture.repo.capture(record()));
      const spam = value(await fixture.repo.appendStage(stage({ lead, to: "spam", changeId: "spam" })));
      const corrected = value(await fixture.repo.appendStage(stage({ lead: spam, to: "new", changeId: "correction" })));
      expect(corrected.attribution).toEqual(attribution);
      const events = value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 100 } })).items;
      expect(events.map(event => event.retractsEventId)).toEqual([null, "initial", null]);
      expect(events.map(event => event.revision)).toEqual([1, 2, 3]);
    });
    it("paginates inbox and history without duplicate boundaries, with stage filters", async () => {
      const lead = value(await fixture.repo.capture(record()));
      await fixture.repo.capture(record({ lead: { leadId: "lead-2", lastEventId: "initial-2", source: { kind: "call", ref: "call-2" } } }));
      await fixture.repo.appendStage(stage({ lead }));
      const first = value(await fixture.repo.list({ context, query: { page: { limit: 1 } } }));
      expect(first.items.map(item => item.leadId)).toEqual(["lead-1"]);
      expect(first.cursor).toBe("lead-1");
      expect(value(await fixture.repo.list({ context, query: { page: { limit: 1, cursor: first.cursor! } } })).items.map(item => item.leadId)).toEqual(["lead-2"]);
      expect(value(await fixture.repo.list({ context, query: { stage: "new", page: { limit: 100 } } })).items.map(item => item.leadId)).toEqual(["lead-2"]);
      const history = value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 1 } }));
      expect(history.cursor).toBe("1");
      expect(value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 1, cursor: history.cursor! } })).items.map(event => event.to)).toEqual(["qualified"]);
    });
    it("detaches erased subjects without altering evidence or allowing replay revival", async () => {
      const lead = value(await fixture.repo.capture(record()));
      await fixture.repo.capture(record({ context: otherWorkspace }));
      const before = value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 100 } }));
      expect(value(await fixture.repo.purgeSubject({ context, subjectId: "subject" }))).toBeUndefined();
      expect(value(await fixture.repo.purgeSubject({ context, subjectId: "subject" }))).toBeUndefined();
      expect(value(await fixture.repo.get({ context, leadId: lead.leadId }))).toEqual({ ...lead, subjectId: null, erased: true });
      expect(value(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 100 } }))).toEqual(before);
      expect(await fixture.repo.capture(record())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await fixture.repo.appendStage(stage({ lead }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(value(await fixture.repo.get({ context: otherWorkspace, leadId: lead.leadId }))?.subjectId).toBe("subject");
    });
    it("rejects identity collisions, forged context, arbitrary content and malformed reads", async () => {
      const lead = value(await fixture.repo.capture(record()));
      expect(await fixture.repo.capture(record({ lead: { source: { kind: "booking", ref: "different" } } }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      const forged = { ...context, principal: { kind: "owner" as const, ownerId: "forged" } };
      expect(await fixture.repo.get({ context: forged, leadId: lead.leadId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await fixture.repo.capture({ ...record(), lead: { ...lead, email: "private@example.test" } } as Parameters<LeadsRepoPort["capture"]>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      for (const limit of [0, 101, 1.5]) expect(await fixture.repo.list({ context, query: { page: { limit } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 1, cursor: "garbage" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const invalid = stage({ lead, to: "spam" });
      expect(await fixture.repo.appendStage({ ...invalid, event: { ...invalid.event, retractsEventId: null } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(value(await fixture.repo.get({ context, leadId: lead.leadId }))).toEqual(lead);
    });
    it("honors cancellation on every operation and detaches caller-owned objects", async () => {
      const options = { signal: AbortSignal.abort() };
      expect(await fixture.repo.capture(record(), options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      const input = record();
      const pending = fixture.repo.capture(input);
      input.lead.attribution.touchId = "mutated-input";
      const lead = value(await pending);
      expect(lead.attribution.touchId).toBe("touch");
      lead.attribution.touchId = "mutated-output";
      expect(value(await fixture.repo.get({ context, leadId: lead.leadId }))?.attribution.touchId).toBe("touch");
      expect(await fixture.repo.appendStage(stage({ lead }), options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.get({ context, leadId: lead.leadId }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.list({ context, query: { page: { limit: 1 } } }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.history({ context, leadId: lead.leadId, page: { limit: 1 } }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.purgeSubject({ context, subjectId: "subject" }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(value(await fixture.repo.get({ context, leadId: lead.leadId }))?.subjectId).toBe("subject");
    });
    it("aggregates the half-open creation cohort per campaign plus workspace-wide unattributed", async () => {
      const capture = async (input: Parameters<typeof cohortLead>[0]) => value(await fixture.repo.capture(cohortLead(input)));
      await capture({ id: "first", createdAt: 1000 });
      await capture({ id: "last", createdAt: 1999 });
      await capture({ id: "end", createdAt: 2000 });
      await capture({ id: "before", createdAt: 999 });
      const spam = await capture({ id: "spam", createdAt: 1500 });
      value(await fixture.repo.appendStage(stage({ lead: spam, to: "spam", changeId: "spam-change" })));
      const disqualified = await capture({ id: "disqualified", createdAt: 1500 });
      value(await fixture.repo.appendStage(stage({ lead: disqualified, to: "disqualified", changeId: "disqualified-change" })));
      await capture({ id: "erased", createdAt: 1500 });
      value(await fixture.repo.purgeSubject({ context, subjectId: "subject-erased" }));
      await capture({ id: "foreign-plugin", createdAt: 1500, campaign: { pluginId: "other-plugin" } });
      await capture({ id: "foreign-account", createdAt: 1500, campaign: { accountId: "other-account" } });
      await capture({ id: "second-campaign", createdAt: 1500, campaign: { vendorCampaignId: "campaign-b" } });
      await capture({ id: "unattributed", createdAt: 1500, campaign: null });
      value(await fixture.repo.capture(cohortLead({ id: "other-workspace", createdAt: 1500, campaign: null, context: otherWorkspace })));
      const query = { context, pluginId: "google-ads", accountId: "account", createdAt: { start: 1000, end: 2000 } };
      expect(value(await fixture.repo.readCohort(query))).toEqual({ counts: [{ vendorCampaignId: "campaign", count: 4 }, { vendorCampaignId: "campaign-b", count: 1 }], unattributed: 1 });
      expect(value(await fixture.repo.readCohort({ ...query, createdAt: { start: 5000, end: 6000 } }))).toEqual({ counts: [], unattributed: 0 });
      expect(await fixture.repo.readCohort({ ...query, createdAt: { start: 0, end: 32 * 86400000 + 1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.readCohort({ ...query, createdAt: { start: 2000, end: 2000 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.readCohort(query, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}
/** Distinct source/event identity per cohort lead; null campaign freezes as unattributed. */
function cohortLead(required: { id: string; createdAt: number; campaign?: Partial<NonNullable<LeadAttribution["campaign"]>> | null; context?: CallContext }) {
  const frozen: LeadAttribution = required.campaign === null ? { campaign: null, touchId: null, touchedAt: null, modelVersion: "last_paid_touch_30d.v1" }
    : { ...attribution, campaign: { ...attribution.campaign!, ...required.campaign } };
  return record({ context: required.context, lead: { leadId: required.id, lastEventId: "event-" + required.id, subjectId: "subject-" + required.id,
    source: { kind: "form", ref: "ref-" + required.id }, createdAt: required.createdAt, attribution: frozen } });
}
