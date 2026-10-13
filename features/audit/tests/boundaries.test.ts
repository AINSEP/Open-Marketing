import { describe, expect, it } from "vitest";
import type { AuditPage, AuditReceipt, AuditRepoPort, AuditService } from "../index.js";
import { createAuditService, createMemoryAuditRepo, createMemoryAuditRedactor } from "../index.js";
import { context, dependencies, entry, value } from "./fixtures.js";

/** Deliberately tainted adapter replies exercise the service's public output boundary. */
function service(required: { page?: AuditPage; receipt?: AuditReceipt; repo?: AuditRepoPort }): AuditService {
  const ports = dependencies();
  const repo = required.repo ?? {
    async append() { return { ok: true as const, value: required.receipt ?? { entryId: "audit-1", recordedAt: 1234 } }; },
    async list() { return { ok: true as const, value: required.page ?? { items: [], cursor: null } }; },
  };
  return createAuditService({ ...ports, repo, redactor: createMemoryAuditRedactor({}) });
}

describe("audit operational boundary regressions", () => {
  it("cancellation during the final redaction fails the whole read", async () => {
    const ports = dependencies();
    const repo = createMemoryAuditRepo(ports);
    value({ outcome: await repo.append({ context: context(), entry: entry() }) });
    const controller = new AbortController();
    const audit = createAuditService({ ...ports, repo, redactor: {
      async redact(input) {
        controller.abort();
        return { ok: true, value: { ...input.entry, references: [] } };
      },
    } });
    expect(await audit.list({ context: context(), query: { limit: 1 } }, { signal: controller.signal }))
      .toEqual({ ok: false, error: { code: "cancelled", message: "Audit cancelled", retryable: false } });
  });

  it("cancellation while awaiting an empty page does not return success", async () => {
    const controller = new AbortController();
    const audit = service({ repo: {
      async append() { return { ok: true, value: { entryId: "audit-1", recordedAt: 1234 } }; },
      async list() { controller.abort(); return { ok: true, value: { items: [], cursor: null } }; },
    } });
    expect(await audit.list({ context: context(), query: { limit: 1 } }, { signal: controller.signal }))
      .toEqual({ ok: false, error: { code: "cancelled", message: "Audit cancelled", retryable: false } });
  });

  it("rejects payload-shaped cursor output without leaking personal data", async () => {
    const audit = service({ page: { items: [entry()], cursor: "person@example.com" } });
    expect(await audit.list({ context: context(), query: { limit: 1 } }))
      .toEqual({ ok: false, error: { code: "protocol_mismatch", message: "Audit protocol_mismatch", retryable: false } });
  });

  it("rejects payload-shaped receipt output without claiming committed evidence", async () => {
    const audit = service({ receipt: { entryId: "Bearer sensitive-token", recordedAt: 1234 } });
    expect(await audit.record({ context: context(), entry: entry() }))
      .toEqual({ ok: false, error: { code: "protocol_mismatch", message: "Audit protocol_mismatch", retryable: false } });
  });

  it("rejects a continuation with no entries instead of allowing an endless export", async () => {
    const audit = service({ page: { items: [], cursor: "audit-1" } });
    expect(await audit.list({ context: context(), query: { limit: 1 } }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("rejects a repeated input cursor instead of allowing an endless export", async () => {
    const audit = service({ page: { items: [entry()], cursor: "audit-1" } });
    expect(await audit.list({ context: context(), query: { limit: 1, cursor: "audit-1" } }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });

  it("preserves a valid continuation and exact operational evidence", async () => {
    const audit = service({ page: { items: [entry()], cursor: "audit-2" } });
    expect(await audit.list({ context: context(), query: { limit: 1, cursor: "audit-1" } }))
      .toEqual({ ok: true, value: { items: [entry({ references: ["[redacted]"] })], cursor: "audit-2" } });
  });

  it("invalid allocated IDs fail before a memory append changes history", async () => {
    const repo = createMemoryAuditRepo({ clock: { now() { return 1234; } }, ids: { next() { return "person@example.com"; } } });
    expect(await repo.append({ context: context(), entry: entry() }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(await repo.list({ context: context(), query: { limit: 1 } }))
      .toEqual({ ok: true, value: { items: [], cursor: null } });
  });
});
