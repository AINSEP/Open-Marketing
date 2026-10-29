import { describe, it, expect } from "vitest";
import type { ObserverPort } from "@open-marketing/contracts";
import type { PolicyRepoPort, PolicyEvidence } from "../../index.js";
import { shareability } from "../../index.js";
import { context, grant, withdrawal, merge, otherOwner, otherWorkspace, subject } from "../fixtures.js";

type RepoHarness = { port: PolicyRepoPort; close?: () => void };

/** One behavioral suite against memory and actual SQL; each test owns its state. */
export function PolicyRepoPortSuite(required: { name: string; create: () => RepoHarness }) {
  describe(required.name + " PolicyRepoPort", () => {
    it("retains exact optional topic/version/digest, rejects drift and malformed digests", async () => {
      const fixture = required.create();
      try {
        const evidence = { ...grant, consent: { ...grant.consent, topic: "conversion", wordingVersion: "v1", wordingDigest: "a".repeat(64) } };
        expect(await fixture.port.appendEvidence({ context, evidence })).toEqual({ ok: true, value: evidence });
        expect(await fixture.port.snapshot({ context, subjectId: subject.subjectId })).toMatchObject({ ok: true, value: { consents: [evidence.consent] } });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...evidence, consent: { ...evidence.consent, wordingVersion: "v2" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...evidence, id: "bad-digest", consent: { ...evidence.consent, wordingDigest: "bad" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      } finally { fixture.close?.(); }
    });
    it("starts with a deny-by-default snapshot", async () => {
      const fixture = required.create();
      try {
        expect(await fixture.port.snapshot({ context, subjectId: subject.subjectId })).toEqual({ ok: true, value: { consents: [], suppressions: [], holdout: false } });
      } finally { fixture.close?.(); }
    });
    it("persists exact destination evidence and distinguishes suppression", async () => {
      const fixture = required.create();
      try {
        expect(await fixture.port.appendEvidence({ context, evidence: grant })).toEqual({ ok: true, value: grant });
        const suppression: PolicyEvidence = { id: "suppress", scope: context.scope, subjectId: subject.subjectId, kind: "suppression", recordedAt: 10, sourceId: "ingress", suppression: { channel: "email", start: 0, end: 100 } };
        expect((await fixture.port.appendEvidence({ context, evidence: suppression })).ok).toBe(true);
        const result = await fixture.port.snapshot({ context, subjectId: subject.subjectId });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("Snapshot failed");
        expect(result.value.consents).toEqual([grant.consent]);
        expect(result.value.suppressions).toEqual([suppression.suppression]);
        expect(shareability({ subject: result.value, destination: { id: "meta", intent: "measurement" }, purpose: "signup", now: 20 })).toEqual({ allowed: true });
        expect(shareability({ subject: result.value, destination: { id: "other", intent: "measurement" }, purpose: "signup", now: 20 })).toEqual({ allowed: false, reason: "consent_missing" });
        expect(shareability({ subject: result.value, destination: { id: "meta", intent: "measurement" }, purpose: "other", now: 20 })).toEqual({ allowed: false, reason: "consent_missing" });
      } finally { fixture.close?.(); }
    });
    it("retries exactly once and refuses changed content under the same ID", async () => {
      const fixture = required.create();
      try {
        const results = await Promise.all([fixture.port.appendEvidence({ context, evidence: grant }), fixture.port.appendEvidence({ context, evidence: grant })]);
        expect(results).toEqual([{ ok: true, value: grant }, { ok: true, value: grant }]);
        const reordered = { ...Object.fromEntries(Object.entries(grant).reverse()), scope: { workspaceId: grant.scope.workspaceId, ownerId: grant.scope.ownerId }, consent: Object.fromEntries(Object.entries(grant.consent).reverse()) } as typeof grant;
        expect(await fixture.port.appendEvidence({ context, evidence: reordered })).toEqual({ ok: true, value: grant });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...grant, consent: { ...grant.consent, purpose: "changed" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        const result = await fixture.port.snapshot({ context, subjectId: subject.subjectId });
        expect(result).toEqual({ ok: true, value: { consents: [grant.consent], suppressions: [], holdout: false } });
      } finally { fixture.close?.(); }
    });
    it("is isolated by owner and workspace, including duplicate evidence IDs", async () => {
      const fixture = required.create();
      try {
        expect((await fixture.port.appendEvidence({ context, evidence: grant })).ok).toBe(true);
        for (const alternate of [otherOwner, otherWorkspace]) {
          expect(await fixture.port.snapshot({ context: alternate, subjectId: subject.subjectId })).toEqual({ ok: true, value: { consents: [], suppressions: [], holdout: false } });
          expect(await fixture.port.appendEvidence({ context: alternate, evidence: grant })).toMatchObject({ ok: false, error: { code: "forbidden" } });
          expect((await fixture.port.appendEvidence({ context: alternate, evidence: { ...grant, scope: alternate.scope } })).ok).toBe(true);
        }
      } finally { fixture.close?.(); }
    });
    it("rejects malformed and mismatched evidence without partial state", async () => {
      const fixture = required.create();
      try {
        const invalid = { ...grant, kind: "withdrawal" } as PolicyEvidence;
        expect(await fixture.port.appendEvidence({ context, evidence: invalid })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...grant, consent: { ...grant.consent, end: grant.consent.start } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await fixture.port.snapshot({ context, subjectId: subject.subjectId })).toEqual({ ok: true, value: { consents: [], suppressions: [], holdout: false } });
      } finally { fixture.close?.(); }
    });
    it("withdrawal survives merging and later grants in either append order", async () => {
      for (const records of [[grant, withdrawal], [withdrawal, grant]]) {
        const fixture = required.create();
        try {
          for (const evidence of records) expect((await fixture.port.appendEvidence({ context, evidence })).ok).toBe(true);
          expect((await fixture.port.appendEvidence({ context, evidence: merge })).ok).toBe(true);
          expect((await fixture.port.appendEvidence({ context, evidence: { ...grant, id: "late-grant", subjectId: "survivor" } })).ok).toBe(true);
          for (const subjectId of ["subject", "survivor"]) {
            await expectWithdrawal({ port: fixture.port, subjectId });
          }
        } finally { fixture.close?.(); }
      }
    });
    it("rejects cross-scope, self, cyclic and repeated source merges", async () => {
      const fixture = required.create();
      try {
        expect(await fixture.port.appendEvidence({ context, evidence: { ...merge, target: { ...merge.target, scope: otherWorkspace.scope } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...merge, target: subject } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect((await fixture.port.appendEvidence({ context, evidence: grant })).ok).toBe(true);
        expect((await fixture.port.appendEvidence({ context, evidence: merge })).ok).toBe(true);
        expect(await fixture.port.appendEvidence({ context, evidence: { ...merge, id: "another-merge" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(await fixture.port.appendEvidence({ context, evidence: { ...merge, id: "cycle", subjectId: "survivor", target: subject } })).toMatchObject({ ok: false, error: { code: "conflict" } });
        expect(await fixture.port.snapshot({ context, subjectId: merge.target.subjectId })).toMatchObject({ ok: true, value: { consents: [grant.consent] } });
      } finally { fixture.close?.(); }
    });
    it("copies both ingress data and snapshot output", async () => {
      const fixture = required.create();
      try {
        const evidence = structuredClone(grant);
        const result = await fixture.port.appendEvidence({ context, evidence });
        Object.assign(evidence.consent, { target: "changed-input" });
        if (!result.ok) throw new Error("Append failed");
        if (result.value.kind === "consent") Object.assign(result.value.consent, { target: "changed-output" });
        const snapshot = await fixture.port.snapshot({ context, subjectId: subject.subjectId });
        if (!snapshot.ok) throw new Error("Snapshot failed");
        expect(snapshot.value.consents).toEqual([grant.consent]);
        Object.assign(snapshot.value.consents[0], { target: "changed-snapshot" });
        expect(await fixture.port.snapshot({ context, subjectId: subject.subjectId })).toEqual({ ok: true, value: { consents: [grant.consent], suppressions: [], holdout: false } });
      } finally { fixture.close?.(); }
    });
    it("honors cancellation before writes and principal scope mismatch", async () => {
      const fixture = required.create();
      try {
        const signal = AbortSignal.abort();
        expect(await fixture.port.appendEvidence({ context, evidence: grant }, { signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
        expect(await fixture.port.snapshot({ context, subjectId: "subject" }, { signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
        const forged = { ...context, principal: { kind: "owner" as const, ownerId: "other-owner" } };
        expect(await fixture.port.appendEvidence({ context: forged, evidence: grant })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      } finally { fixture.close?.(); }
    });
  });
}

/** Assert merged output through the actual gate, keeping nested fixture loops shallow. */
async function expectWithdrawal(required: { port: PolicyRepoPort; subjectId: string }): Promise<void> {
  const snapshot = await required.port.snapshot({ context, subjectId: required.subjectId });
  if (!snapshot.ok) throw new Error("Snapshot failed");
  expect(shareability({ subject: snapshot.value, destination: { id: "meta", intent: "measurement" }, purpose: "signup", now: 50 })).toEqual({ allowed: false, reason: "consent_withdrawn" });
}

/** Shared observer contract for the double and any future concrete metadata sink. */
export function PolicyObserverPortSuite(required: { create: () => ObserverPort & { events: Parameters<ObserverPort["observe"]>[0][] } }) {
  describe("PolicyObserverPort", () => {
    it("retains operation and correlation metadata without input aliasing", () => {
      const observer = required.create();
      const event = { operation: "policy.snapshot", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" };
      observer.observe(event);
      event.traceId = "changed";
      expect(observer.events).toEqual([{ operation: "policy.snapshot", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
  });
}
