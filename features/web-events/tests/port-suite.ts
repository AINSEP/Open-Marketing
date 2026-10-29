import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClockPort } from "@open-marketing/contracts";
import type { WebEventRepoPort } from "../index.js";
import { clockFixture, context, destinationUrl, event, otherOwner, otherWorkspace, touch, visit } from "./fixtures.js";

type Harness = { repo: WebEventRepoPort; close?: () => void };
/** Same behavioral assertions for instance-owned memory and actual SQLite adapters. */
export function webEventRepoSuite(required: { name: string; create: (required: { clock: ClockPort }) => Harness }): void {
  describe(required.name, () => {
    let fixture: Harness;
    let time: { now: number };
    beforeEach(() => { const clock = clockFixture(); time = clock.time; fixture = required.create(clock); });
    afterEach(() => fixture.close?.());
    it("persists link-backed OM campaign IDs and preserves them on replay and scoped read", async () => {
      const landing = event({ subjectId: "subject", properties: { linkId: "link", campaignId: "om-campaign" } });
      const saved = { ...touch({ event: landing }), campaignId: "om-campaign" };
      const input = { context, event: landing, touch: saved };
      expect(await fixture.repo.recordTouch(input)).toEqual({ ok: true, value: saved });
      expect(await fixture.repo.recordTouch({ ...input, touch: { ...saved, touchId: "retry" } })).toEqual({ ok: true, value: saved });
      const query = { context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 };
      expect(await fixture.repo.touchesFor(query)).toEqual({ ok: true, value: [saved] });
      expect(await fixture.repo.touchesFor({ ...query, context: otherWorkspace })).toEqual({ ok: true, value: [] });
      const changed = event({ ...landing, properties: { linkId: "link", campaignId: "different-campaign" } });
      expect(await fixture.repo.recordTouch({ context, event: changed, touch: touch({ event: changed }) }))
        .toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("isolates destination receipts, preserves replay age and detects destination changes", async () => {
      const destinationId = createHash("sha256").update(destinationUrl).digest("hex");
      const query = { context, destinationId };
      expect(await fixture.repo.lastHeartbeat(query)).toEqual({ ok: true, value: null });
      const landing = event({ properties: { pageUrl: destinationUrl + "?private=discard#fragment" } });
      const input = { context, event: landing, touch: touch({ event: landing }) };
      expect((await fixture.repo.recordTouch(input)).ok).toBe(true);
      time.now = 2000;
      expect((await fixture.repo.recordTouch(input)).ok).toBe(true);
      expect(await fixture.repo.lastHeartbeat(query)).toEqual({ ok: true, value: 1000 });
      for (const alternate of [otherOwner, otherWorkspace]) expect(await fixture.repo.lastHeartbeat({ ...query, context: alternate })).toEqual({ ok: true, value: null });
      const changed = event({ properties: { pageUrl: destinationUrl + "/different" } });
      expect(await fixture.repo.recordTouch({ context, event: changed, touch: touch({ event: changed }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const second = event({ eventId: "second", properties: { pageUrl: destinationUrl } });
      expect((await fixture.repo.recordTouch({ context, event: second, touch: touch({ event: second, touchId: "second" }) })).ok).toBe(true);
      expect(await fixture.repo.lastHeartbeat(query)).toEqual({ ok: true, value: 2000 });
      expect(await fixture.repo.lastHeartbeat({ context, destinationId: "not-a-digest" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.lastHeartbeat(query, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
    it("replays the original touch and rejects changed click or event content", async () => {
      const input = { context, event: event(), touch: touch() };
      expect(await fixture.repo.recordTouch(input)).toEqual({ ok: true, value: touch() });
      expect(await fixture.repo.recordTouch({ ...input, event: event({ receivedAt: 999, cursor: 42, traceId: "retry-trace" }), touch: touch({ touchId: "retry-touch" }) })).toEqual({ ok: true, value: touch() });
      const changed = event({ properties: { ...event().properties, fbclid: "changed-click" } });
      expect(await fixture.repo.recordTouch({ context, event: changed, touch: touch({ event: changed }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const changedTime = event({ occurredAt: 101 });
      expect(await fixture.repo.recordTouch({ context, event: changedTime, touch: touch({ event: changedTime }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("isolates scoped keys and does not allow touch-ID collisions", async () => {
      expect((await fixture.repo.recordTouch({ context, event: event(), touch: touch() })).ok).toBe(true);
      for (const alternate of [otherOwner, otherWorkspace]) {
        expect((await fixture.repo.recordTouch({ context: alternate, event: event(), touch: touch() })).ok).toBe(true);
        expect(await fixture.repo.bindVisitor({ context: alternate, visitId: visit.visitId, subjectId: "subject" })).toMatchObject({ ok: false });
      }
      const next = event({ eventId: "next" });
      expect(await fixture.repo.recordTouch({ context, event: next, touch: touch({ event: next }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("persists visits, binds once, and never manufactures or resets bindings", async () => {
      expect(await fixture.repo.bindVisitor({ context, visitId: "missing", subjectId: "subject" })).toMatchObject({ ok: false });
      expect(await fixture.repo.saveVisit({ context, visit })).toEqual({ ok: true, value: visit });
      const bound = { ...visit, subjectId: "subject" };
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" })).toEqual({ ok: true, value: bound });
      expect(await fixture.repo.saveVisit({ context, visit })).toEqual({ ok: true, value: bound });
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" })).toEqual({ ok: true, value: bound });
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "other" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.saveVisit({ context, visit: { ...visit, visitId: "duplicate-anonymous" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.saveVisit({ context: otherWorkspace, visit })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("uses current binding and [start,end), newest-first occurrence/ID order and limit", async () => {
      await fixture.repo.saveVisit({ context, visit });
      for (const [eventId, occurredAt, touchId] of [["late", 200, "z"], ["tie-z", 100, "b"], ["tie-a", 100, "a"], ["end", 300, "end"]] as const) {
        const input = event({ eventId, occurredAt });
        await fixture.repo.recordTouch({ context, event: input, touch: touch({ event: input, touchId }) });
      }
      const query = { context, subjectId: "subject", window: { start: 100, end: 300 }, limit: 100 };
      expect(await fixture.repo.touchesFor(query)).toEqual({ ok: true, value: [] });
      await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" });
      time.now = 3000;
      const result = await fixture.repo.touchesFor({ ...query, limit: 2 });
      expect(result.ok && result.value.map(item => item.touchId)).toEqual(["z", "b"]);
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "expired" } });
      expect(await fixture.repo.touchesFor({ ...query, context: otherWorkspace })).toEqual({ ok: true, value: [] });
    });
    it("erases bound and direct click data without restoring it on replay", async () => {
      await fixture.repo.saveVisit({ context, visit });
      await fixture.repo.recordTouch({ context, event: event(), touch: touch() });
      await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" });
      const direct = event({ eventId: "direct", anonymousId: undefined, subjectId: "subject" });
      await fixture.repo.recordTouch({ context, event: direct, touch: touch({ event: direct, touchId: "direct-touch" }) });
      expect(await fixture.repo.purgeSubject({ context, subjectId: "subject" })).toEqual({ ok: true, value: undefined });
      expect(await fixture.repo.purgeSubject({ context, subjectId: "subject" })).toEqual({ ok: true, value: undefined });
      expect(await fixture.repo.recordTouch({ context, event: event(), touch: touch() })).toEqual({ ok: true, value: { ...touch(), clickIdentifiers: {} } });
      const query = { context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 };
      expect(await fixture.repo.touchesFor(query)).toEqual({ ok: true, value: [{ ...touch({ event: direct, touchId: "direct-touch" }), clickIdentifiers: {} }] });
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" })).toMatchObject({ ok: false });
    });
    it("rejects malformed, unknown PII properties, mismatched touches and read bounds", async () => {
      const input = event({ properties: { email: "fixture@example.test" } });
      expect(await fixture.repo.recordTouch({ context, event: input, touch: touch({ event: input }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.repo.recordTouch({ context, event: event(), touch: { ...touch(), eventId: "wrong" } })).toMatchObject({ ok: false });
      for (const limit of [0, 101, 1.5]) expect(await fixture.repo.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 100 }, limit })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const forged = { ...context, principal: { kind: "owner" as const, ownerId: "forged" } };
      expect(await fixture.repo.saveVisit({ context: forged, visit })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("preserves another scope and direct subject when an anonymous visit is erased", async () => {
      await fixture.repo.saveVisit({ context, visit });
      await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" });
      const different = event({ eventId: "different", subjectId: "different-subject" });
      const differentTouch = touch({ event: different, touchId: "different-touch" });
      await fixture.repo.recordTouch({ context, event: different, touch: differentTouch });
      await fixture.repo.recordTouch({ context: otherWorkspace, event: event(), touch: touch() });
      const query = { context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 };
      expect(await fixture.repo.touchesFor(query)).toEqual({ ok: true, value: [] });
      await fixture.repo.purgeSubject({ context, subjectId: "subject" });
      expect(await fixture.repo.touchesFor({ ...query, subjectId: "different-subject" })).toEqual({ ok: true, value: [differentTouch] });
      expect(await fixture.repo.recordTouch({ context: otherWorkspace, event: event(), touch: touch() })).toEqual({ ok: true, value: touch() });
    });
    it("makes simultaneous exact replays return one touch and rejects changed visit identity", async () => {
      const input = { context, event: event(), touch: touch() };
      const result = await Promise.all([fixture.repo.recordTouch(input), fixture.repo.recordTouch({ ...input, touch: touch({ touchId: "retry-touch" }) })]);
      expect(result).toEqual([{ ok: true, value: touch() }, { ok: true, value: touch() }]);
      await fixture.repo.saveVisit({ context, visit });
      expect(await fixture.repo.saveVisit({ context, visit: { ...visit, anonymousId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.repo.saveVisit({ context, visit: { ...visit, expiresAt: 3000 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      time.now = 2000;
      expect(await fixture.repo.saveVisit({ context, visit })).toMatchObject({ ok: false, error: { code: "expired" } });
    });
    it("honors cancellation without any state change", async () => {
      const options = { signal: AbortSignal.abort() };
      expect(await fixture.repo.saveVisit({ context, visit }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.recordTouch({ context, event: event(), touch: touch() }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.purgeSubject({ context, subjectId: "subject" }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.bindVisitor({ context, visitId: visit.visitId, subjectId: "subject" }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await fixture.repo.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 100 }, limit: 1 }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
    it("copies inputs and outputs instead of exposing mutable storage", async () => {
      const input = event();
      const result = await fixture.repo.recordTouch({ context, event: input, touch: touch() });
      Object.assign(input.properties, { gclid: "mutated" });
      if (!result.ok) throw new Error("Record failed");
      Object.assign(result.value.clickIdentifiers, { fbclid: "mutated" });
      expect(await fixture.repo.recordTouch({ context, event: event(), touch: touch() })).toEqual({ ok: true, value: touch() });
    });
  });
}
