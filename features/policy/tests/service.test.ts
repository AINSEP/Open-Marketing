import { describe, expect, it } from "vitest";
import { createMemoryPolicyRepo, createPolicyService } from "../index.js";
import type { Outcome } from "@open-marketing/contracts";
import type { PolicyEvidence, PolicyRepoPort } from "../index.js";
import { context, grant, memoryObserver } from "./fixtures.js";

const clock = { now: () => 50 };

describe("policy service", () => {
  it("delegates snapshots and evidence, preserving stable ingress IDs and trace context", async () => {
    const repo = createMemoryPolicyRepo({});
    const observer = memoryObserver();
    const service = createPolicyService({ repo, clock }, { observer });
    expect(await service.appendEvidence({ context, evidence: grant })).toEqual({ ok: true, value: grant });
    expect(await service.snapshot({ context, subjectId: "subject" })).toEqual({ ok: true, value: { consents: [grant.consent], suppressions: [], holdout: false } });
    expect(observer.events).toEqual([
      { operation: "policy.appendEvidence", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" },
      { operation: "policy.snapshot", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" },
    ]);
  });
  it("rejects future evidence and dependency/clock failures explicitly", async () => {
    const repo = createMemoryPolicyRepo({});
    const service = createPolicyService({ repo, clock: { now: () => 5 } });
    expect(await service.appendEvidence({ context, evidence: grant })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const broken = createPolicyService({ repo, clock: { now: () => { throw new Error("clock private error"); } } });
    expect(await broken.appendEvidence({ context, evidence: grant })).toEqual({ ok: false, error: { code: "unavailable", message: "Policy dependency unavailable", retryable: true } });
    expect(await repo.snapshot({ context, subjectId: "subject" })).toEqual({ ok: true, value: { consents: [], suppressions: [], holdout: false } });
  });
  it("does not let observer failure change a committed append", async () => {
    const repo = createMemoryPolicyRepo({});
    const service = createPolicyService({ repo, clock }, { observer: { observe() { throw new Error("observer"); } } });
    expect(await service.appendEvidence({ context, evidence: grant })).toEqual({ ok: true, value: grant });
    expect(await repo.snapshot({ context, subjectId: "subject" })).toEqual({ ok: true, value: { consents: [grant.consent], suppressions: [], holdout: false } });
  });
  it("forwards cancellation and converts repository throws without leaking details", async () => {
    const failureRepo: PolicyRepoPort = { async snapshot() { throw new Error("sensitive database error"); }, async appendEvidence(): Promise<Outcome<PolicyEvidence>> { throw new Error("private evidence"); } };
    const service = createPolicyService({ repo: failureRepo, clock });
    expect(await service.snapshot({ context, subjectId: "subject" })).toEqual({ ok: false, error: { code: "unavailable", message: "Policy dependency unavailable", retryable: true } });
    expect(await service.appendEvidence({ context, evidence: grant }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await service.appendEvidence({ context, evidence: grant })).toEqual({ ok: false, error: { code: "unavailable", message: "Policy dependency unavailable", retryable: true } });
  });
  it("never performs I/O at construction", () => {
    const repo: PolicyRepoPort = { snapshot() { throw new Error("startup I/O"); }, appendEvidence() { throw new Error("startup I/O"); } };
    expect(() => createPolicyService({ repo, clock: { now() { throw new Error("startup time"); } } })).not.toThrow();
  });
});
