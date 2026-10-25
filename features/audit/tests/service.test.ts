import { describe, it, expect } from "vitest";
import type { AuditEntry, AuditRepoPort, AuditRedactorPort, AuditService } from "../index.js";
import { createAuditService, createMemoryAuditRepo, createMemoryAuditRedactor, createMemoryAuditObserver, createJiniAuditRedactor } from "../index.js";
import { context, entry, dependencies, value } from "./fixtures.js";

function service(required: { repo?: AuditRepoPort; redactor?: AuditRedactorPort } = {}): AuditService {
  const ports = dependencies();
  return createAuditService({ ...ports, repo: required.repo ?? createMemoryAuditRepo(ports), redactor: required.redactor ?? createMemoryAuditRedactor({}) });
}

/** Demonstrates the caller's required-intent barrier; audit itself exposes no dispatch authority. */
async function effectAfterReceipt(required: { audit: AuditService; effect(required: Record<string, never>): Promise<string> }) {
  const receipt = await required.audit.record({ context: context(), entry: entry() });
  if (!receipt.ok) return receipt;
  return { ok: true as const, value: await required.effect({}) };
}

describe("audit service", () => {
  it.each(["drop", "identity", "choice", "in-place"])("rejects %s changes to structured approval evidence during redaction", async mutation => {
    const original: AuditEntry = { ...entry(), kind: "approval", approval: {
      response: { cardId: "card", operationId: "operation-1", argumentsDigest: "a".repeat(64), choice: "allow" },
      approver: { kind: "local_token", ownerId: "owner-1", deviceId: "device", tokenId: "reference" },
    } };
    const audit = service({ redactor: { async redact(input) {
      if (mutation === "drop") { const { approval: _approval, ...rest } = input.entry; return { ok: true, value: rest }; }
      const projected = mutation === "in-place" ? input.entry : structuredClone(input.entry);
      if (mutation === "identity") projected.approval!.approver = { kind: "jini_user", userId: "substituted-user" };
      else projected.approval!.response.choice = "cancel";
      return { ok: true, value: projected };
    } } });
    value({ outcome: await audit.record({ context: context(), entry: original }) });
    expect(await audit.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("preserves nonsecret approval identity in the normal redacted operational view", async () => {
    const original: AuditEntry = { ...entry(), kind: "approval", approval: {
      response: { cardId: "card", operationId: "operation-1", argumentsDigest: "a".repeat(64), choice: "allow" },
      approver: { kind: "local_token", ownerId: "owner-1", deviceId: "device", tokenId: "reference" },
    } };
    const audit = service();
    value({ outcome: await audit.record({ context: context(), entry: original }) });
    expect(value({ outcome: await audit.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([{ ...original, references: ["[redacted]"] }]);
  });
  it("stores durable references and exposes only the redacted operational view", async () => {
    const ports = dependencies();
    const repo = createMemoryAuditRepo(ports);
    const observer = createMemoryAuditObserver({});
    const audit = createAuditService({ ...ports, repo, redactor: createMemoryAuditRedactor({}) }, { observer });
    const original = entry({ references: ["person@example.com", "Bearer sensitive-token"] });
    const receipt = value({ outcome: await audit.record({ context: context(), entry: original }) });
    expect(receipt).toEqual({ entryId: "audit-1", recordedAt: 1234 });
    expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([original]);
    const operational = value({ outcome: await audit.list({ context: context(), query: { limit: 10 } }) });
    expect(operational.items).toEqual([entry({ references: ["[redacted]", "[redacted]"] })]);
    expect(observer.events({})).toEqual([
      { operation: "audit.record", outcome: "ok", correlationId: "correlation-1", traceId: "trace-1", runId: "run-1" },
      { operation: "audit.list", outcome: "ok", correlationId: "correlation-1", traceId: "trace-1", runId: "run-1" },
    ]);
    expect(JSON.stringify(observer.events({}))).not.toContain("person@example.com");
  });

  it("required audit failure prevents a new caller effect", async () => {
    let effects = 0;
    const audit = service({ repo: {
      async append() { return { ok: false, error: { code: "unavailable", message: "secret driver message", retryable: false } }; },
      async list() { return { ok: true, value: { items: [], cursor: null } }; },
    } });
    const failed = await effectAfterReceipt({ audit, async effect() { effects += 1; return "dispatched"; } });
    expect(failed).toEqual({ ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } });
    expect(effects).toBe(0);
    const success = await effectAfterReceipt({ audit: service(), async effect() { effects += 1; return "dispatched"; } });
    expect(success).toEqual({ ok: true, value: "dispatched" });
    expect(effects).toBe(1);
  });

  it("maps thrown adapter errors without leaking credentials or claiming success", async () => {
    const audit = service({ repo: {
      async append() { throw new Error("password=secret person@example.com"); },
      async list() { throw new Error("password=secret person@example.com"); },
    } });
    const failure = { ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } };
    expect(await audit.record({ context: context(), entry: entry() })).toEqual(failure);
    expect(await audit.list({ context: context(), query: { limit: 10 } })).toEqual(failure);
  });

  it("does not let telemetry failure invalidate a committed receipt", async () => {
    const ports = dependencies();
    const repo = createMemoryAuditRepo(ports);
    const audit = createAuditService({ ...ports, repo, redactor: createMemoryAuditRedactor({}) }, { observer: { observe() { throw new Error("sink down"); } } });
    expect(value({ outcome: await audit.record({ context: context(), entry: entry() }) }).entryId).toBe("audit-1");
    expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
  });

  it("redacts payload-shaped correlation identifiers in telemetry", async () => {
    const ports = dependencies();
    const observer = createMemoryAuditObserver({});
    const audit = createAuditService({ ...ports, repo: createMemoryAuditRepo(ports), redactor: createMemoryAuditRedactor({}) }, { observer });
    value({ outcome: await audit.record({ context: context({ correlationId: "person@example.com", traceId: "Bearer secret", runId: "123.456.789.000" }), entry: entry() }) });
    expect(observer.events({})).toEqual([{ operation: "audit.record", outcome: "ok", correlationId: "[redacted]", traceId: "[redacted]", runId: "[redacted]" }]);
  });

  it("rejects invalid payloads, queries and receipts at boundaries", async () => {
    let appends = 0;
    const audit = service({ repo: {
      async append() { appends += 1; return { ok: true, value: { entryId: "x", recordedAt: NaN } }; },
      async list() { return { ok: true, value: { items: [], cursor: null } }; },
    } });
    expect(await audit.record({ context: context(), entry: { ...entry(), arguments: "secret" } as AuditEntry })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(appends).toBe(0);
    expect(await audit.record({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(await audit.list({ context: context(), query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await audit.record({ context: context(), entry: entry() }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(appends).toBe(1);
  });

  it("fails closed on an oversized adapter page", async () => {
    const audit = service({ repo: {
      async append() { return { ok: true, value: { entryId: "audit-1", recordedAt: 1234 } }; },
      async list() { return { ok: true, value: { items: [entry(), entry()], cursor: null } }; },
    } });
    expect(await audit.list({ context: context(), query: { limit: 1 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("fails the whole page if a later redaction fails, without partial output", async () => {
    let redactions = 0;
    const audit = service({ redactor: { async redact(input) {
      redactions += 1;
      if (redactions === 2) return { ok: false, error: { code: "unavailable", message: "secret", retryable: false } };
      return { ok: true, value: { ...input.entry, references: ["[redacted]"] } };
    } } });
    value({ outcome: await audit.record({ context: context(), entry: entry() }) });
    value({ outcome: await audit.record({ context: context(), entry: entry({ kind: "outcome" }) }) });
    expect(await audit.list({ context: context(), query: { limit: 10 } })).toEqual({ ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } });
    expect(redactions).toBe(2);
  });

  it("cannot change exact-review digest or lineage through a redactor", async () => {
    const audit = service({ redactor: { async redact(input) { return { ok: true, value: { ...input.entry, argumentsDigest: "b".repeat(64) } }; } } });
    value({ outcome: await audit.record({ context: context(), entry: entry() }) });
    expect(await audit.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("detects an in-place redactor mutation against the original evidence snapshot", async () => {
    const audit = service({ redactor: { async redact(input) {
      (input.entry as { argumentsDigest: string }).argumentsDigest = "b".repeat(64);
      return { ok: true, value: input.entry };
    } } });
    value({ outcome: await audit.record({ context: context(), entry: entry() }) });
    expect(await audit.list({ context: context(), query: { limit: 10 } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("a repository cannot mutate the requested operation filter to bypass output validation", async () => {
    const audit = service({ repo: {
      async append() { return { ok: true, value: { entryId: "audit-1", recordedAt: 1234 } }; },
      async list(input) {
        (input.query as { operationId: string }).operationId = "other";
        return { ok: true, value: { items: [entry({ operationId: "other" })], cursor: null } };
      },
    } });
    expect(await audit.list({ context: context(), query: { limit: 10, operationId: "operation-1" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("does not expose an entry from another operation filter", async () => {
    const audit = service({ repo: {
      async append() { return { ok: true, value: { entryId: "audit-1", recordedAt: 1234 } }; },
      async list() { return { ok: true, value: { items: [entry({ operationId: "other" })], cursor: null } }; },
    } });
    expect(await audit.list({ context: context(), query: { limit: 10, operationId: "operation-1" } })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("propagates cancellation during redaction without exposing a partial page", async () => {
    const controller = new AbortController();
    const audit = service({ redactor: { async redact(input) { controller.abort(); return { ok: true, value: { ...input.entry, references: [] } }; } } });
    value({ outcome: await audit.record({ context: context(), entry: entry() }) });
    value({ outcome: await audit.record({ context: context(), entry: entry() }) });
    expect(await audit.list({ context: context(), query: { limit: 10 } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});

describe("memory repository and Jini adapter edges", () => {
  it("fails explicitly on duplicate generated IDs instead of overwriting", async () => {
    const ports = { clock: { now() { return 1234; } }, ids: { next() { return "duplicate"; } } };
    const repo = createMemoryAuditRepo(ports);
    value({ outcome: await repo.append({ context: context(), entry: entry() }) });
    expect(await repo.append({ context: context(), entry: entry({ kind: "outcome" }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
  });
  it("capacity stops appending without inventing retention", async () => {
    const repo = createMemoryAuditRepo(dependencies(), { maxEntries: 1 });
    value({ outcome: await repo.append({ context: context(), entry: entry() }) });
    expect(await repo.append({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(value({ outcome: await repo.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([entry()]);
  });
  it("invalid clocks/IDs and dependency failures cannot create evidence", async () => {
    const invalid = createMemoryAuditRepo({ clock: { now() { return -1; } }, ids: { next() { return ""; } } });
    expect(await invalid.append({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const failed = createMemoryAuditRepo({ clock: { now() { throw new Error("clock failure"); } }, ids: { next() { return "valid"; } } });
    expect(await failed.append({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(value({ outcome: await failed.list({ context: context(), query: { limit: 10 } }) }).items).toEqual([]);
  });
  it("maps scrubber failure and rejects a known secret masquerading as an identity", async () => {
    const broken = createJiniAuditRedactor({ scrubber: { redact() { throw new Error("secret failure"); } } });
    expect(await broken.redact({ context: context(), entry: entry() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const scrubber = { redact({ text }: { text: string }) { return text === "secret-identity" ? "[REDACTED]" : text; } };
    const safe = createJiniAuditRedactor({ scrubber });
    expect(await safe.redact({ context: context(), entry: entry({ operationId: "secret-identity" }) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
