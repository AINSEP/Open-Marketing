/** Service/worker behavior on both compositions. Tests are authored, not executed in this lane. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Outcome } from "@open-marketing/contracts";
import type { FormPublication, PublicSubmissionResult, SubmissionReceipt } from "../index.js";
import { FormDefinitionNotFoundError, FormRateLimitExceededError, FormSlugConflictError, FormSubmissionValidationError } from "@jini-ai/cms/forms";
import { formsBoundary, renderPublication } from "../src/jini.js";
import { formsStorageSuite } from "./port-suites.js";
import { body, context, createFixture, otherContext, publication } from "./fixtures.js";
import type { Fixture } from "./fixtures.js";

formsStorageSuite({ name: "memory", create: () => createFixture({ kind: "memory" }) });
formsStorageSuite({ name: "SQLite", create: () => createFixture({ kind: "sql" }) });

function acceptedReceipt(required: { result: Outcome<PublicSubmissionResult> }): SubmissionReceipt {
  if (!required.result.ok || required.result.value.status === "discarded") throw new Error("Expected durable receipt");
  return required.result.value.receipt;
}

for (const kind of ["memory", "sql"] as const) {
  describe(`${kind} forms service and acceptance worker`, () => {
    let fixture: Fixture;
    beforeEach(async () => { fixture = createFixture({ kind }); expect(await fixture.service().publish({ context, publication: publication() })).toEqual({ ok: true, value: publication() }); });
    afterEach(() => fixture.close());
    const submit = (input: { attemptId?: string; body?: unknown; visitToken?: string; publicationId?: string } = {}) => fixture.service().submitPublic({ context, slug: "lead", publicationId: input.publicationId ?? "publication-one", attemptId: input.attemptId ?? "attempt-one", body: input.body ?? body, ...(input.visitToken === undefined ? {} : { visitToken: input.visitToken }) });

    it("accepts one submission, one durable receipt and one ID-only job; acceptance stays async", async () => {
      const result = await submit({ visitToken: "signed-visit-one" });
      expect(result).toMatchObject({ ok: true, value: { status: "accepted" } });
      const receipt = acceptedReceipt({ result });
      expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 0 });
      expect(fixture.jobRecords()).toEqual([{ jobId: receipt.jobId, submissionId: receipt.submissionId, publicationId: receipt.publicationId, context }]);
      expect(JSON.stringify([receipt, fixture.jobRecords()])).not.toContain(body.email);
      expect(JSON.stringify([receipt, fixture.jobRecords()])).not.toContain("signed-visit-one");
      const saved = await fixture.submissions.findById({ workspaceId: context.scope.workspaceId, id: receipt.submissionId });
      expect(saved?.data).toEqual({ ...body, om_publication: "publication-one", om_vt: "signed-visit-one" });
    });
    it("durable replay uses sorted keys and returns original IDs with no duplicate work", async () => {
      const first = acceptedReceipt({ result: await submit() });
      expect(await submit({ body: { measurement: false, marketing: true, email: body.email } })).toEqual({ ok: true, value: { status: "duplicate", receipt: first } });
      expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 0 });
    });
    it("changed answers or token under the same attempt conflict", async () => {
      const first = acceptedReceipt({ result: await submit({ visitToken: "visit-one" }) });
      expect(await submit({ body: { ...body, marketing: false }, visitToken: "visit-one" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await submit({ visitToken: "visit-two" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await submit({ visitToken: "visit-one" })).toEqual({ ok: true, value: { status: "duplicate", receipt: first } });
      expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 0 });
    });
    it("honeypot creates no submission, receipt, job or acceptance", async () => {
      expect(await submit({ body: { ...body, email: "invalid", _hp: "bot-filled" } })).toEqual({ ok: true, value: { status: "discarded" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
      expect((await submit()).ok).toBe(true);
    });
    it.each(["throw", "outcome"] as const)("jobs %s rolls back partial submission and job; retry succeeds", async failure => {
      fixture.fail({ target: "jobs", kind: failure });
      expect(await submit()).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
      fixture.fail({ target: "jobs", kind: "none" });
      expect(await submit()).toMatchObject({ ok: true, value: { status: "accepted" } });
      expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 0 });
    });
    it("receipt denial rolls back Jini submission and already-enqueued job", async () => {
      const service = fixture.service({ receipts: { ...fixture.receipts, async append() { return { ok: false, error: { code: "conflict", message: "Injected receipt denial", retryable: false } }; } } });
      expect(await service.submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
    });
    it("missing live Jini definition denies submission before durable writes", async () => {
      const service = fixture.service({ definitions: { ...fixture.definitions, async findBySlug() { return null; } } });
      expect(await service.submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
    });
    it("older publications remain usable after publication and live definition edits", async () => {
      const newer = publication({ version: 2, publicationId: "publication-two" });
      const changed: FormPublication = { ...newer, fields: [...newer.fields, { id: "company", label: "Company", type: "text", required: true }] };
      expect(await fixture.service().publish({ context, publication: changed })).toEqual({ ok: true, value: changed });
      const definition = await fixture.definitions.findById({ workspaceId: context.scope.workspaceId, id: newer.formDefinitionId });
      if (!definition) throw new Error("Missing definition");
      await fixture.definitions.update({ ...definition, fields: [{ id: "future", label: "Future", type: "text", required: true }] });
      const receipt = acceptedReceipt({ result: await submit() });
      expect(await fixture.worker({ receipt })).toEqual({ ok: true, value: { subjectId: "subject-" + receipt.submissionId } });
      expect(fixture.captures()[0].consent.map(item => item.choice)).toEqual([true, false]);
      expect(await submit({ publicationId: "publication-two", attemptId: "new-attempt" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await fixture.service().renderHostedForm({ context, slug: "lead" })).toMatchObject({ ok: true, value: { publicationId: "publication-two" } });
    });
    it("renders exact escaped wording and unchecked independent boxes plus attempt/publication fields", async () => {
      const result = await fixture.service().renderHostedForm({ context, slug: "lead" });
      if (!result.ok) throw new Error("Expected rendered form");
      expect(result.value.html).toContain("Send me product news");
      expect(result.value.html).toContain("Measure my conversions");
      expect(result.value.html).toContain('name="om_publication" value="publication-one"');
      expect(result.value.html).toContain('name="_attempt"');
      expect(result.value.html).toContain('name="_hp"');
      expect(result.value.html).not.toContain(" checked");
      const custom = { ...publication(), consent: publication().consent.map(item => ({ ...item, wording: '<script>alert("x")</script>' })) };
      expect(renderPublication({ publication: custom, attemptId: '"/><script>x</script>' })).not.toContain("<script>");
      expect(renderPublication({ publication: custom, attemptId: "attempt" })).toContain("&lt;script&gt;");
    });
    it("server metadata overrides body metadata; tokens remain absent when the argument is absent", async () => {
      const receipt = acceptedReceipt({ result: await submit({ body: { ...body, om_publication: "wrong", _attempt: "wrong", om_vt: "forged-token" } }) });
      const saved = await fixture.submissions.findById({ workspaceId: context.scope.workspaceId, id: receipt.submissionId });
      expect(saved?.data).toEqual({ ...body, om_publication: "publication-one" });
      await fixture.worker({ receipt });
      expect(fixture.captures()[0]).not.toHaveProperty("visitToken");
    });
    it("native checked and omitted consent boxes become true and false independently", async () => {
      const receipt = acceptedReceipt({ result: await submit({ body: { email: body.email, marketing: "on" } }) });
      expect(await fixture.worker({ receipt })).toMatchObject({ ok: true });
      expect(fixture.captures()[0].consent).toEqual(publication().consent.map(({ wording: _wording, ...item }, index) => ({ ...item, choice: index === 0 })));
    });
    it("bounded opaque tokens round-trip beyond identifier length, and oversized tokens deny writes", async () => {
      const token = "signed-" + "x".repeat(1000);
      const receipt = acceptedReceipt({ result: await submit({ visitToken: token }) });
      expect(await fixture.worker({ receipt })).toMatchObject({ ok: true });
      expect(fixture.captures()[0].visitToken).toBe(token);
      expect(await submit({ visitToken: "x".repeat(4097), attemptId: "other" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 1 });
    });
    it.each(["throw", "outcome"] as const)("acceptance %s rolls back partial effects; retry and lost-ack replay create one result", async failure => {
      const receipt = acceptedReceipt({ result: await submit({ visitToken: "visit-one" }) });
      fixture.fail({ target: "acceptance", kind: failure });
      expect(await fixture.worker({ receipt })).toMatchObject({ ok: false });
      expect(fixture.counts().accepted).toBe(0);
      fixture.fail({ target: "acceptance", kind: "none" });
      const expected = { ok: true, value: { subjectId: "subject-" + receipt.submissionId } };
      expect(await fixture.worker({ receipt })).toEqual(expected);
      // Simulate a lost acknowledgement by re-delivering the same committed ID-only job.
      expect(await fixture.worker({ receipt })).toEqual(expected);
      expect(fixture.captures()).toHaveLength(1);
      expect(fixture.captures()[0]).toEqual({ context, submissionId: receipt.submissionId, publicationId: receipt.publicationId,
        consent: publication().consent.map(({ wording: _wording, ...item }, index) => ({ ...item, choice: index === 0 })), visitToken: "visit-one" });
    });
    it("erased submission cannot be accepted", async () => {
      const receipt = acceptedReceipt({ result: await submit() });
      await fixture.erase({ submissionId: receipt.submissionId });
      expect(await fixture.worker({ receipt })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fixture.captures()).toEqual([]);
    });
    it("missing publication or submission IDs cannot trigger acceptance", async () => {
      const receipt = acceptedReceipt({ result: await submit() });
      expect(await fixture.worker({ receipt: { ...receipt, publicationId: "missing" } })).toMatchObject({ ok: false });
      expect(await fixture.worker({ receipt: { ...receipt, submissionId: "missing" } })).toMatchObject({ ok: false });
      expect(fixture.captures()).toEqual([]);
    });
    it.each([{ ...body, om_publication: "wrong" }, { ...body, om_publication: "publication-one", measurement: "on" }, { ...body, om_publication: "publication-one", om_vt: "" }])("malformed stored association/choice/token denies all acceptance", async data => {
      const receipt = acceptedReceipt({ result: await submit() });
      await fixture.changeData({ submissionId: receipt.submissionId, data });
      expect(await fixture.worker({ receipt })).toMatchObject({ ok: false });
      expect(fixture.captures()).toEqual([]);
    });
    it("bounded listing retains scanned cursor across a sparse publication page", async () => {
      const old = acceptedReceipt({ result: await submit() });
      const newer = publication({ version: 2, publicationId: "publication-two" });
      await fixture.service().publish({ context, publication: newer });
      const latest = acceptedReceipt({ result: await submit({ publicationId: newer.publicationId, attemptId: "new-attempt" }) });
      const first = await fixture.service().listSubmissions({ context, publicationId: "publication-one", page: { limit: 1 } });
      expect(first).toEqual({ ok: true, value: { items: [], cursor: latest.submissionId } });
      const next = await fixture.service().listSubmissions({ context, publicationId: "publication-one", page: { limit: 1, cursor: latest.submissionId } });
      expect(next).toMatchObject({ ok: true, value: { items: [{ id: old.submissionId }], cursor: null } });
      expect(await fixture.service().listSubmissions({ context, publicationId: "publication-one", page: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("workspace/slug mismatches and cancelled calls cannot write", async () => {
      expect(await fixture.service().submitPublic({ context: otherContext, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body })).toMatchObject({ ok: false });
      expect(await fixture.service().submitPublic({ context, slug: "wrong", publicationId: "publication-one", attemptId: "attempt-one", body })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await fixture.service().submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
    });
    it.each([null, { ...body, email: "not-an-email" }, { ...body, unknown: "value" }, { ...body, om_unknown: "value" }, { ...body, email: "x".repeat(5001) }])("invalid public input creates nothing", async invalid => {
      const result = await fixture.service().submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body: invalid });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
    });
  });
}

describe("durable SQLite restart and admission", () => {
  let fixture: Fixture;
  beforeEach(async () => { fixture = createFixture({ kind: "sql" }); await fixture.service().publish({ context, publication: publication() }); });
  afterEach(() => fixture.close());
  const submit = () => fixture.service().submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body, visitToken: "visit-one" });

  it("receipt replay and worker token reload survive a native handle/kernel restart", async () => {
    const receipt = acceptedReceipt({ result: await submit() });
    fixture.restart();
    expect(await submit()).toEqual({ ok: true, value: { status: "duplicate", receipt } });
    expect(await fixture.service().submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body: { ...body, email: "changed@example.test" }, visitToken: "visit-one" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await fixture.worker({ receipt })).toMatchObject({ ok: true });
    fixture.restart();
    expect(await fixture.worker({ receipt })).toMatchObject({ ok: true });
    expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 1 });
    expect(fixture.captures()[0].visitToken).toBe("visit-one");
  });
  it("overlapping roots reject instead of joining another request's transaction", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const receipts = { ...fixture.receipts, async find(input: Parameters<Fixture["receipts"]["find"]>[0]) {
      entered.resolve(); await release.promise; return fixture.receipts.find(input);
    } };
    const first = fixture.service({ receipts }).submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-one", body });
    await entered.promise;
    try {
      expect(await fixture.service().submitPublic({ context, slug: "lead", publicationId: "publication-one", attemptId: "attempt-two", body })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally { release.resolve(); }
    expect(await first).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(fixture.counts()).toEqual({ submissions: 1, jobs: 1, receipts: 1, accepted: 0 });
  });
});

describe("foreign boundary errors", () => {
  it.each([
    { error: new FormDefinitionNotFoundError({ message: "private provider detail" }), code: "unavailable" },
    { error: new FormSubmissionValidationError({ message: "private answer detail" }), code: "invalid_input" },
    { error: new FormSlugConflictError({ message: "private provider detail", slug: "lead" }), code: "conflict" },
    { error: new FormRateLimitExceededError({ message: "private provider detail", retryAfterSeconds: 1 }), code: "limit_exceeded" },
    { error: new Error("private SQL detail"), code: "unavailable" },
  ])("sanitizes foreign failures into typed Outcomes", async input => {
    const result = await formsBoundary({ work: async () => { throw input.error; } });
    expect(result).toMatchObject({ ok: false, error: { code: input.code } });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

describe("publication validation bounds and consent semantics", () => {
  let fixture: Fixture;
  beforeEach(() => { fixture = createFixture({ kind: "memory" }); });
  afterEach(() => fixture.close());
  it.each([
    { ...publication(), fields: publication().fields.map(field => field.id === "marketing" ? { ...field, required: true } : field) },
    { ...publication(), fields: publication().fields.map(field => field.id === "marketing" ? { ...field, default: true } : field) },
    { ...publication(), fields: publication().fields.map(field => field.id === "marketing" ? { ...field, checkboxValue: "yes" } : field) },
    { ...publication(), consent: [publication().consent[0], publication().consent[0]] },
    { ...publication(), fields: [...publication().fields, { id: "om_authored", label: "Reserved", type: "text" as const, required: false }] },
    { ...publication(), fields: [{ id: "upload", label: "Upload", type: "file", required: false }] },
    { ...publication(), fields: Array.from({ length: 21 }, (_value, index) => ({ id: `field_${index}`, label: "Extra", type: "text" as const, required: false })) },
  ])("rejects forced/prechecked/ambiguous consent, reserved fields, uploads and field-count overflow", async invalid => {
    expect(await fixture.service().publish({ context, publication: invalid as FormPublication })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.definitions.list({ workspaceId: context.scope.workspaceId })).toEqual([]);
    expect(await fixture.publications.find({ context, publicationId: invalid.publicationId })).toEqual({ ok: true, value: null });
  });
  it("64 KiB publication and answer bounds apply before durable work", async () => {
    const fields = Array.from({ length: 20 }, (_value, index) => ({ id: `field_${index}`, label: "Text", type: "text" as const, required: false }));
    const valid: FormPublication = { ...publication(), fields, consent: [] };
    const oversized: FormPublication = { ...valid, fields: fields.map(field => ({ ...field, default: "x".repeat(5000) })) };
    expect(await fixture.service().publish({ context, publication: oversized })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.service().publish({ context, publication: valid })).toEqual({ ok: true, value: valid });
    const answers = Object.fromEntries(fields.map(field => [field.id, "x".repeat(5000)]));
    expect(await fixture.service().submitPublic({ context, slug: "lead", publicationId: valid.publicationId, attemptId: "attempt", body: answers })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.counts()).toEqual({ submissions: 0, jobs: 0, receipts: 0, accepted: 0 });
  });
  it("a publication collision cannot leave a new definition behind", async () => {
    await fixture.service().publish({ context, publication: publication() });
    const conflicting = { ...publication(), formDefinitionId: "new-definition", slug: "new-slug" };
    expect(await fixture.service().publish({ context, publication: conflicting })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await fixture.definitions.findById({ workspaceId: context.scope.workspaceId, id: "new-definition" })).toBeNull();
    expect(await fixture.publications.find({ context, publicationId: "publication-one" })).toEqual({ ok: true, value: publication() });
  });
});
