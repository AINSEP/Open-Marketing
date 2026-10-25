import { describe, expect, it } from "vitest";
import { dispatchDecisionSchema } from "@open-marketing/contracts";
import { dispatchDecision, sendability, shareability } from "../index.js";
import type { DispatchInput, SubjectPolicy } from "../index.js";

const subject = { scope: { ownerId: "owner", workspaceId: "workspace" }, subjectId: "canonical" };
const alias = { ...subject, subjectId: "merged-alias" };
const grant = { scope: "destination", target: "meta", purpose: "signup", status: "granted", start: 10, end: 100 } as const;
const channel = { id: "email", intent: "marketing" } as const;
const messageGrant = { ...grant, scope: "channel", target: "email" } as const;
const policy: SubjectPolicy = { consents: [grant, messageGrant], suppressions: [], holdout: false };
const conversion = { kind: "conversion_sharing", destinationId: "meta", purpose: "signup" } as const;
const messaging = { kind: "messaging", channel, purpose: "signup" } as const;

/** Fresh supplied evidence; no repository, clock or provider is involved. */
function input(required: Partial<DispatchInput> = {}): DispatchInput {
  return { subject, policy, lineage: [{ subject, erasure: "none" }], action: conversion, now: 50, ...required };
}

describe("dispatchDecision", () => {
  it.each([conversion, messaging])("allows current exact consent for $kind", action => {
    expect(dispatchDecision(input({ action }))).toEqual({ allowed: true });
  });

  it.each([{ start: 0, end: 10 }, { start: 10, end: 100 }, { start: 100, end: 200 }])(
    "treats om.processing as durable regardless of its window %j", window => {
      const snapshot = { ...policy, suppressions: [{ channel: "om.processing", ...window }] };
      expect(shareability({ subject: snapshot, destination: { id: "meta", intent: "measurement" }, purpose: "signup", now: 50 }))
        .toEqual({ allowed: true });
      for (const action of [conversion, messaging]) {
        expect(dispatchDecision(input({ action, policy: snapshot }))).toEqual({ allowed: false, reason: "suppressed" });
      }
    },
  );

  it.each(["erased", "pending"] as const)("denies a merged alias marked %s for both actions", erasure => {
    const lineage = [{ subject, erasure: "none" }, { subject: alias, erasure }] as const;
    for (const action of [conversion, messaging]) {
      expect(dispatchDecision(input({ action, lineage })))
        .toEqual({ allowed: false, reason: erasure === "erased" ? "erased" : "erasure_pending" });
    }
  });

  it("prioritizes invalid evidence, erased, pending erasure, processing suppression, then action consent", () => {
    const snapshot = { ...policy, consents: [], suppressions: [{ channel: "om.processing", start: 0, end: 10 }] };
    const lineage = [{ subject, erasure: "pending" }, { subject: alias, erasure: "erased" }] as const;
    expect(dispatchDecision(input({ policy: snapshot, lineage, now: NaN }))).toEqual({ allowed: false, reason: "invalid_input" });
    expect(dispatchDecision(input({ policy: snapshot, lineage }))).toEqual({ allowed: false, reason: "erased" });
    expect(dispatchDecision(input({ policy: snapshot, lineage: [lineage[0]] }))).toEqual({ allowed: false, reason: "erasure_pending" });
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual({ allowed: false, reason: "suppressed" });
    expect(dispatchDecision(input({ policy: { ...snapshot, suppressions: [] } }))).toEqual({ allowed: false, reason: "consent_missing" });
  });

  it("preserves merged-alias withdrawal regardless of consent or lineage order and withdrawal expiry", () => {
    const withdrawn = { ...grant, status: "withdrawn", start: 20, end: 30 } as const;
    const lineage = [{ subject, erasure: "none" }, { subject: alias, erasure: "none" }] as const;
    // The caller has combined the canonical grant with this alias's withdrawal.
    for (const consents of [[grant, withdrawn], [withdrawn, grant]]) {
      for (const family of [lineage, [...lineage].reverse()]) {
        expect(dispatchDecision(input({ policy: { ...policy, consents }, lineage: family })))
          .toEqual({ allowed: false, reason: "consent_withdrawn" });
      }
    }
  });

  it.each([
    { action: { ...conversion, destinationId: "google" }, now: 50 },
    { action: { ...conversion, purpose: "other" }, now: 50 },
    { action: conversion, now: 9 },
    { action: conversion, now: 100 },
    { action: { ...messaging, channel: { ...channel, id: "sms" } }, now: 50 },
    { action: { ...messaging, purpose: "other" }, now: 50 },
    { action: messaging, now: 100 },
  ])("requires matching active consent %j", overrides => {
    expect(dispatchDecision(input(overrides))).toEqual({ allowed: false, reason: "consent_missing" });
  });

  it.each([conversion, messaging])("includes the exact grant start for $kind", action => {
    expect(dispatchDecision(input({ action, now: 10 }))).toEqual({ allowed: true });
  });

  it("keeps channel suppression separate from conversion sharing and preserves half-open intervals", () => {
    const snapshot = { ...policy, suppressions: [{ channel: "email", start: 10, end: 100 }] };
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual({ allowed: true });
    expect(dispatchDecision(input({ policy: snapshot, action: messaging, now: 10 }))).toEqual({ allowed: false, reason: "suppressed" });
    expect(dispatchDecision(input({ policy: { ...snapshot, suppressions: [{ channel: "email", start: 10, end: 50 }] }, action: messaging })))
      .toEqual({ allowed: true });
    expect(dispatchDecision(input({ policy: { ...snapshot, suppressions: [{ channel: "sms", start: 10, end: 100 }] }, action: messaging })))
      .toEqual({ allowed: true });
  });

  it("keeps messaging consent usable when conversion-sharing consent is withdrawn", () => {
    const snapshot = { ...policy, consents: [messageGrant, { ...grant, status: "withdrawn" as const }] };
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual({ allowed: false, reason: "consent_withdrawn" });
    expect(dispatchDecision(input({ policy: snapshot, action: messaging }))).toEqual({ allowed: true });
  });

  it("delegates marketing holdout, transactional messaging and measurement intent", () => {
    const snapshot = { ...policy, holdout: true };
    expect(sendability({ subject: snapshot, channel, purpose: "signup", now: 50 })).toEqual({ allowed: false, reason: "holdout" });
    expect(dispatchDecision(input({ policy: snapshot, action: messaging }))).toEqual({ allowed: false, reason: "holdout" });
    expect(dispatchDecision(input({ policy: snapshot, action: { ...messaging, channel: { ...channel, intent: "transactional" } } })))
      .toEqual({ allowed: true });
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual({ allowed: true });
  });

  it.each([
    { count: 0, limit: 0 }, { count: 2, limit: 2 }, { count: 3, limit: 2 },
  ])("preserves messaging cap denial %j", frequencyCap => {
    const snapshot = { ...policy, frequencyCap };
    expect(dispatchDecision(input({ policy: snapshot, action: messaging }))).toEqual({ allowed: false, reason: "frequency_cap" });
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual({ allowed: true });
  });

  it("allows messaging below the cap", () => {
    expect(dispatchDecision(input({ policy: { ...policy, frequencyCap: { count: 1, limit: 2 } }, action: messaging })))
      .toEqual({ allowed: true });
  });

  it.each([
    undefined, null, {},
    input({ lineage: [] }),
    input({ lineage: [{ subject: alias, erasure: "none" }] }),
    input({ lineage: [{ subject, erasure: "none" }, { subject, erasure: "erased" }] }),
    input({ lineage: [{ subject, erasure: "none" }, { subject: { ...alias, scope: { ...subject.scope, ownerId: "other" } }, erasure: "none" }] }),
    input({ lineage: [{ subject, erasure: "none" }, { subject: { ...alias, scope: { ...subject.scope, workspaceId: "other" } }, erasure: "none" }] }),
    { ...input(), lineage: undefined },
    { ...input(), lineage: [{ subject, erasure: "failed" }] },
    { ...input(), subject: { ...subject, subjectId: " " } },
    { ...input(), policy: { ...policy, holdout: "false" } },
    { ...input(), policy: { ...policy, consents: [{ ...grant, end: 10 }] } },
    { ...input(), policy: { ...policy, consents: [{ ...grant, purpose: " " }] } },
    { ...input(), policy: { ...policy, suppressions: [{ channel: "email", start: 0, end: 0 }] } },
    { ...input(), action: { ...conversion, destinationId: " " } },
    { ...input(), action: { ...conversion, purpose: " " } },
    { ...input(), action: { ...conversion, destinationId: "a".repeat(257) } },
    { ...input(), action: { ...messaging, channel: { id: " ", intent: "marketing" } } },
    { ...input(), action: { ...messaging, channel: { ...channel, intent: "audience" } } },
    { ...input(), action: { kind: "lead_receipt", purpose: "signup" } },
  ])("fails closed on malformed supplied evidence %#", value => {
    expect(dispatchDecision(value as DispatchInput)).toEqual({ allowed: false, reason: "invalid_input" });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("denies invalid time %s", now => {
    expect(dispatchDecision(input({ now }))).toEqual({ allowed: false, reason: "invalid_input" });
  });

  it.each([
    { count: -1, limit: 2 }, { count: 0.5, limit: 2 }, { count: NaN, limit: 2 },
    { count: 0, limit: -1 }, { count: 0, limit: Infinity }, { count: 0, limit: Number.MAX_SAFE_INTEGER + 1 },
  ])("validates counters even for conversion sharing %j", frequencyCap => {
    expect(dispatchDecision(input({ policy: { ...policy, frequencyCap } }))).toEqual({ allowed: false, reason: "invalid_input" });
  });

  it.each([100, 101])("enforces the lineage bound without truncating %i members", count => {
    const lineage = Array.from({ length: count }, (_, index) => ({ subject: { ...subject, subjectId: index === 0 ? subject.subjectId : `alias-${index}` }, erasure: "none" as const }));
    const expected = count === 100 ? { allowed: true } : { allowed: false, reason: "invalid_input" };
    expect(dispatchDecision(input({ lineage }))).toEqual(expected);
  });

  it.each([
    { consents: 100_000, suppressions: 0, allowed: true },
    { consents: 50_000, suppressions: 50_000, allowed: true },
    { consents: 1, suppressions: 99_999, allowed: true },
    { consents: 100_001, suppressions: 0, allowed: false },
    { consents: 1, suppressions: 100_000, allowed: false },
    { consents: 50_001, suppressions: 50_000, allowed: false },
    { consents: 0, suppressions: 100_001, allowed: false },
  ])("bounds combined policy evidence without truncation %j", counts => {
    const snapshot = { ...policy, consents: Array.from({ length: counts.consents }, () => grant), suppressions: Array.from({ length: counts.suppressions }, () => ({ channel: "email", start: 10, end: 100 })) };
    const expected = counts.allowed ? { allowed: true } : { allowed: false, reason: "invalid_input" };
    expect(dispatchDecision(input({ policy: snapshot }))).toEqual(expected);
  });

  it("does not mutate deeply frozen evidence and returns the committed decision shape", () => {
    const frozenPolicy = Object.freeze({ consents: Object.freeze([Object.freeze({ ...grant }), Object.freeze({ ...messageGrant })]), suppressions: Object.freeze([]), holdout: false, frequencyCap: Object.freeze({ count: 1, limit: 2 }) });
    const frozenSubject = Object.freeze({ ...subject, scope: Object.freeze({ ...subject.scope }) });
    const frozen = Object.freeze(input({ subject: frozenSubject, policy: frozenPolicy, lineage: Object.freeze([Object.freeze({ subject: frozenSubject, erasure: "none" as const })]), action: Object.freeze({ ...conversion }) }));
    const before = JSON.stringify(frozen);
    const allowed = dispatchDecision(frozen);
    const denied = dispatchDecision({ ...frozen, now: 100 });
    expect(allowed).toEqual({ allowed: true });
    expect(denied).toEqual({ allowed: false, reason: "consent_missing" });
    expect(dispatchDecision(frozen)).toEqual(allowed);
    expect(dispatchDecisionSchema.safeParse(allowed).success).toBe(true);
    expect(dispatchDecisionSchema.safeParse(denied).success).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});
