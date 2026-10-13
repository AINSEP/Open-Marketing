/** Hermetic compositions: Jini repos plus OM ports, never real jobs/contact adapters or vendors. */
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sqliteKernel } from "@jini-ai/db/kernel/sqlite";
import { InMemoryFormDefinitionRepo, InMemoryFormSubmissionRepo } from "@jini-ai/cms/forms";
import { formDefinitionRepoFor, formSubmissionRepoFor } from "@jini-ai/cms/forms/sql";
import { createFakeClock } from "@open-marketing/om-clock";
import type { CallContext, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import { acceptFormSubmission, createFormsService, createMemoryFormsStorage, createSqlFormsStorage } from "../index.js";
import type { FormAcceptancePort, FormDefinitionRepoPort, FormJobsPort, FormPublication, FormPublicationPort, FormReceiptPort, FormSubjectPort, FormSubmissionRepoPort, FormsService, SubmissionReceipt } from "../index.js";
import { definitionView } from "../src/rules.js";

export const context: CallContext = { scope: { ownerId: "owner-one", workspaceId: "d590965a-e81d-4560-a341-7396d8aa5ba3" },
  principal: { kind: "service", serviceId: "fixture-ingress" }, correlationId: "correlation-one", traceId: "trace-one", runId: "run-one" };
export const otherContext: CallContext = { ...context, scope: { ownerId: "owner-two", workspaceId: "9b5d3f0b-a7f5-4052-881b-631d0519fda0" } };
export const body = { email: "lead@example.test", marketing: true, measurement: false };
export const receipt: SubmissionReceipt = { publicationId: "publication-one", attemptId: "attempt-one", bodyDigest: "a".repeat(64), submissionId: "submission-one", jobId: "job-one" };

/** Fixed synthetic wording; hashes are independently computed with Node's standard implementation. */
export function publication(required: { context?: CallContext; version?: number; publicationId?: string } = {}): FormPublication {
  const wording = [{ fieldId: "marketing", purpose: "marketing_email", topic: "product", target: "newsletter", wording: "Send me product news", wordingVersion: "v1" },
    { fieldId: "measurement", purpose: "measurement", topic: "conversions", target: "meta", wording: "Measure my conversions", wordingVersion: "v1" }];
  return { scope: (required.context ?? context).scope, publicationId: required.publicationId ?? "publication-one", formDefinitionId: "definition-one", slug: "lead", version: required.version ?? 1,
    fields: [{ id: "email", label: "Email", type: "email", required: true }, { id: "marketing", label: "Marketing label", type: "checkbox", required: false }, { id: "measurement", label: "Measurement label", type: "checkbox", required: false }],
    consent: wording.map(item => ({ ...item, wordingDigest: createHash("sha256").update(item.wording).digest("hex") })), publishedAt: 1_792_000_000_123 };
}
export type Failure = "none" | "throw" | "outcome";
type Accepted = Parameters<FormAcceptancePort["accept"]>[0];
interface Job { jobId: string; submissionId: string; publicationId: string; context: CallContext }
export interface Fixture {
  unitOfWork: UnitOfWork; publications: FormPublicationPort; receipts: FormReceiptPort; subjects: FormSubjectPort;
  definitions: FormDefinitionRepoPort; submissions: FormSubmissionRepoPort; jobs: FormJobsPort; acceptance: FormAcceptancePort;
  service(required?: Partial<Parameters<typeof createFormsService>[0]>): FormsService;
  worker(required: { receipt: SubmissionReceipt }): Promise<Outcome<{ subjectId: string }>>;
  prepare(required: { publication: FormPublication; receipt?: SubmissionReceipt }): Promise<void>;
  counts(): { submissions: number; jobs: number; receipts: number; accepted: number };
  jobRecords(): Job[];
  captures(): Omit<Accepted, "session">[];
  fail(required: { target: "jobs" | "acceptance"; kind: Failure }): void;
  restart(): void;
  erase(required: { submissionId: string }): Promise<void>;
  changeData(required: { submissionId: string; data: Record<string, string | boolean> }): Promise<void>;
  close(): void;
}

class Rollback extends Error {
  readonly result: unknown;
  constructor(required: { result: unknown }) { super("Fixture returned denial"); this.result = required.result; }
}
function failed(required: { value: unknown }): boolean {
  return typeof required.value === "object" && required.value !== null && "ok" in required.value && required.value.ok === false;
}
function denial<T>(): Outcome<T> { return { ok: false, error: { code: "unavailable", message: "Injected fixture failure", retryable: true } }; }

/** Real SQLite, one existing-handle Jini kernel, and request-bound sessions. Returned denials abort
 * the kernel root just like throws. Busy roots and expired sessions are rejected explicitly. */
function sqlBinding(required: { handle: Database.Database }) {
  const kernel = sqliteKernel(required.handle);
  let busy = false;
  const unitOfWork: UnitOfWork = { async transaction({ work }) {
    if (busy) throw new Error("Fixture root busy");
    busy = true;
    let active = true;
    const session: SqlSession = {
      async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
        if (!active) throw new Error("Fixture session expired");
        return kernel.run(() => {
          const statement = required.handle.prepare(input.text);
          const bindings = Object.fromEntries((input.values ?? []).map((value, index) => [String(index + 1), value]));
          if (statement.reader) return { rows: statement.all(bindings) as Row[], rowCount: null };
          return { rows: [] as Row[], rowCount: statement.run(bindings).changes };
        });
      },
      async transaction(input) { if (!active) throw new Error("Fixture session expired"); return input.work({ session }); },
    };
    try {
      return await kernel.transaction(async () => {
        const result = await work({ session });
        if (failed({ value: result })) throw new Rollback({ result });
        return result;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.result as Awaited<ReturnType<typeof work>>;
      throw error;
    } finally { active = false; busy = false; }
  } };
  const tables = { definitions: "om_form_definitions", submissions: "om_form_submissions" };
  return { unitOfWork, ...createSqlFormsStorage({ unitOfWork }), definitions: formDefinitionRepoFor({ kernel, tables }), submissions: formSubmissionRepoFor({ kernel, tables }) };
}

/** Test-only memory coordination snapshots Jini rows, new definitions, jobs and acceptance state.
 * This is composition responsibility; OM's memory storage never claims atomicity over other stores. */
function memoryBinding(required: { jobRows: Job[]; accepted: Omit<Accepted, "session">[] }) {
  const definitions = new InMemoryFormDefinitionRepo();
  const submissions = new InMemoryFormSubmissionRepo();
  const storage = createMemoryFormsStorage({ submissions });
  const submissionIds = new Set<string>();
  const receiptIds = new Set<string>();
  const created: { workspaceId: string; id: string }[] = [];
  const repo: FormDefinitionRepoPort = { findById: input => definitions.findById(input), findBySlug: input => definitions.findBySlug(input),
    list: input => definitions.list(input), update: input => definitions.update(input), isSlugTaken: input => definitions.isSlugTaken(input),
    async create(input) { await definitions.create(input); created.push({ workspaceId: input.workspaceId, id: input.id }); } };
  const submissionRepo: FormSubmissionRepoPort = { findById: input => submissions.findById(input), listByDefinition: (input, options) => submissions.listByDefinition(input, options),
    async create(input) { await submissions.create(input); submissionIds.add(input.id); } };
  const receipts: FormReceiptPort = { find: (input, options) => storage.receipts.find(input, options), async append(input, options) {
    const result = await storage.receipts.append(input, options);
    if (result.ok) receiptIds.add(JSON.stringify([input.context.scope.workspaceId, input.receipt.publicationId, input.receipt.attemptId]));
    return result;
  } };
  const unitOfWork: UnitOfWork = { async transaction({ work }) {
    const jobs = structuredClone(required.jobRows);
    const accepted = structuredClone(required.accepted);
    const start = created.length;
    const priorSubmissions = [...submissionIds];
    const priorReceipts = [...receiptIds];
    try {
      return await submissions.transaction(async () => {
        const result = await storage.unitOfWork.transaction({ work });
        if (failed({ value: result })) throw new Rollback({ result });
        return result;
      });
    } catch (error) {
      required.jobRows.splice(0, required.jobRows.length, ...jobs);
      required.accepted.splice(0, required.accepted.length, ...accepted);
      submissionIds.clear(); priorSubmissions.forEach(id => submissionIds.add(id));
      receiptIds.clear(); priorReceipts.forEach(id => receiptIds.add(id));
      for (const key of created.splice(start)) await definitions.hardDelete(key);
      if (error instanceof Rollback) return error.result as Awaited<ReturnType<typeof work>>;
      throw error;
    }
  } };
  return { ...storage, receipts, unitOfWork, definitions: repo, submissions: submissionRepo, memorySubmissions: submissions,
    counts: () => ({ submissions: submissionIds.size, jobs: required.jobRows.length, receipts: receiptIds.size, accepted: required.accepted.length }) };
}

/** Owns fixture lifetimes and failure controls. SQL migrations apply only to an owned temporary file.
 * Restart reopens a native handle and reconstructs all repos, exercising durable receipt replay.
 * @example const fixture = createFixture({ kind: "sql" }); try { ... } finally { fixture.close(); } */
export function createFixture(required: { kind: "memory" | "sql" }): Fixture {
  const jobRows: Job[] = [];
  const accepted: Omit<Accepted, "session">[] = [];
  const memory = memoryBinding({ jobRows, accepted });
  const directory = required.kind === "sql" ? mkdtempSync(join(tmpdir(), "om-forms-")) : null;
  const file = directory ? join(directory, "forms.sqlite") : null;
  let handle = file ? new Database(file) : null;
  if (handle) {
    handle.pragma("foreign_keys = ON");
    handle.exec("CREATE TABLE workspace (workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL); CREATE TABLE job (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payload TEXT NOT NULL, context_json TEXT NOT NULL); CREATE TABLE fixture_acceptance (submission_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, capture_json TEXT);");
    handle.exec(readFileSync(new URL("../migrations/0001_forms.sql", import.meta.url), "utf8"));
    for (const current of [context, otherContext]) handle.prepare("INSERT INTO workspace VALUES (?,?)").run(current.scope.workspaceId, current.scope.ownerId);
  }
  let binding = handle ? sqlBinding({ handle }) : memory;
  let serial = 0;
  const ids = { next: (_input: Record<string, never>) => `fixture-${String(++serial).padStart(6, "0")}` };
  const clock = createFakeClock({ initial: 1_792_000_000_123 });
  let jobsFailure: Failure = "none";
  let acceptanceFailure: Failure = "none";

  const jobs: FormJobsPort = { async enqueue(input) {
    const jobId = ids.next({});
    const row: Job = { jobId, submissionId: input.submissionId, publicationId: input.publicationId, context: input.context };
    if (handle) await input.session.query({ text: "INSERT INTO job VALUES ($1,$2,$3,$4)", values: [jobId, input.context.scope.workspaceId, JSON.stringify({ submissionId: input.submissionId, publicationId: input.publicationId }), JSON.stringify(input.context)] });
    else jobRows.push(row);
    if (jobsFailure === "throw") throw new Error("Injected jobs throw");
    if (jobsFailure === "outcome") return denial();
    return { ok: true, value: { jobId } };
  } };
  const acceptance: FormAcceptancePort = { async accept(input) {
    if (!input.session) return denial();
    const { session, ...capture } = input;
    if (handle) await session.query({ text: "INSERT INTO fixture_acceptance (submission_id,subject_id) VALUES ($1,$2) ON CONFLICT(submission_id) DO NOTHING", values: [input.submissionId, "subject-" + input.submissionId] });
    else if (!accepted.some(item => item.submissionId === input.submissionId)) accepted.push(capture);
    if (acceptanceFailure === "throw") throw new Error("Injected acceptance throw");
    if (acceptanceFailure === "outcome") return denial();
    if (handle) await session.query({ text: "UPDATE fixture_acceptance SET capture_json=$1 WHERE submission_id=$2", values: [JSON.stringify(capture), input.submissionId] });
    return { ok: true, value: { subjectId: "subject-" + input.submissionId } };
  } };
  const fixture: Fixture = {
    get unitOfWork() { return binding.unitOfWork; }, get publications() { return binding.publications; }, get receipts() { return binding.receipts; }, get subjects() { return binding.subjects; },
    get definitions() { return binding.definitions; }, get submissions() { return binding.submissions; }, jobs, acceptance,
    service(overrides = {}) { return createFormsService({ ...binding, jobs, acceptance, clock, ids, ...overrides }); },
    worker(input) { return acceptFormSubmission({ ...binding, acceptance, context, submissionId: input.receipt.submissionId, publicationId: input.receipt.publicationId }); },
    async prepare(input) {
      await binding.unitOfWork.transaction({ work: async ({ session }) => {
        const workspaceId = input.publication.scope.workspaceId;
        if (!await binding.definitions.findById({ workspaceId, id: input.publication.formDefinitionId })) await binding.definitions.create({ ...definitionView(input), fields: [...input.publication.fields] });
        if (!input.receipt) return;
        const saved = input.receipt;
        await binding.submissions.create({ id: saved.submissionId, workspaceId, formDefinitionId: input.publication.formDefinitionId, data: { ...body, om_publication: input.publication.publicationId }, sourceIp: null, submittedAt: new Date(input.publication.publishedAt).toISOString() });
        if (handle) await session.query({ text: "INSERT INTO job VALUES ($1,$2,$3,$4)", values: [saved.jobId, workspaceId, JSON.stringify({ submissionId: saved.submissionId, publicationId: saved.publicationId }), JSON.stringify(context)] });
      } });
    },
    counts() {
      if (!handle) return memory.counts();
      return { submissions: count({ table: "om_form_submissions" }), jobs: count({ table: "job" }), receipts: count({ table: "om_form_submission_receipts" }), accepted: count({ table: "fixture_acceptance" }) };
    },
    jobRecords() {
      if (!handle) return structuredClone(jobRows);
      return (handle.prepare("SELECT * FROM job").all() as { id: string; payload: string; context_json: string }[]).map(row => ({ jobId: row.id, ...JSON.parse(row.payload), context: JSON.parse(row.context_json) }));
    },
    captures() {
      if (!handle) return structuredClone(accepted);
      return (handle.prepare("SELECT capture_json FROM fixture_acceptance WHERE capture_json IS NOT NULL").all() as { capture_json: string }[]).map(row => JSON.parse(row.capture_json));
    },
    fail(input) { if (input.target === "jobs") jobsFailure = input.kind; else acceptanceFailure = input.kind; },
    restart() { if (!file || !handle) return; handle.close(); handle = new Database(file); handle.pragma("foreign_keys = ON"); binding = sqlBinding({ handle }); },
    async erase(input) {
      if (handle) handle.prepare("UPDATE om_form_submissions SET deleted_at='erased',data_json='{}' WHERE id=?").run(input.submissionId);
      else {
        const saved = await memory.memorySubmissions.findAnyById({ workspaceId: context.scope.workspaceId, id: input.submissionId });
        if (!saved) throw new Error("Missing fixture record");
        await memory.memorySubmissions.save({ ...saved, deletedAt: "erased", data: {} });
      }
    },
    async changeData(input) {
      if (handle) handle.prepare("UPDATE om_form_submissions SET data_json=? WHERE id=?").run(JSON.stringify(input.data), input.submissionId);
      else {
        const saved = await memory.memorySubmissions.findAnyById({ workspaceId: context.scope.workspaceId, id: input.submissionId });
        if (!saved) throw new Error("Missing fixture record");
        await memory.memorySubmissions.save({ ...saved, data: input.data });
      }
    },
    close() { if (handle?.open) handle.close(); if (directory) rmSync(directory, { recursive: true, force: true }); },
  };
  function count(input: { table: string }): number { return (handle!.prepare(`SELECT COUNT(*) AS count FROM ${input.table}`).get() as { count: number }).count; }
  return fixture;
}
