import { z } from "zod";
import type { InMemoryFormSubmissionRepo } from "@jini-ai/cms/forms";
/** Transaction-local OM storage double. Its unit covers publications/replay/subject receipts; Jini answers are an injected double. */
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { FormPublicationPort, FormReceiptPort, FormSubjectPort } from "./ports.js";
import type { FormPublication, SubmissionReceipt, FormSubjectReceipt } from "./types.js";
import { formSubjectSchema, checkContext, deny, parsePublication, parseReceipt, samePublication } from "./rules.js";
import { formsBoundary, unwrap } from "./jini.js";

interface State { publications: FormPublication[]; receipts: Map<string, SubmissionReceipt>; subjects: Map<string, FormSubjectReceipt> }

function receiptKey(required: { context: CallContext; publicationId: string; attemptId: string }): string {
  return JSON.stringify([required.context.scope.workspaceId, required.publicationId, required.attemptId]);
}

/** Inert memory storage; concurrent roots fail busy, expired/foreign sessions fail closed.
 * Clones prevent callers mutating immutable evidence. O(n) transaction snapshot for n stored rows.
 * Composition must coordinate other memory participants; this unit cannot roll back Jini rows.
 * @example const storage = createMemoryFormsStorage({}); */
export function createMemoryFormsStorage(required: { submissions?: Pick<InMemoryFormSubmissionRepo, "findAnyById" | "save"> }): { publications: FormPublicationPort; receipts: FormReceiptPort; subjects: FormSubjectPort; unitOfWork: UnitOfWork } {
  let state: State = { publications: [], receipts: new Map(), subjects: new Map() };
  let busy = false;
  const sessions = new WeakMap<SqlSession, State>();

  function sessionState(required: { session: SqlSession }): State {
    const local = sessions.get(required.session);
    if (!local) return unwrap({ outcome: deny<never>({ code: "unavailable", message: "Forms session is expired or foreign" }) });
    return local;
  }

  const unitOfWork: UnitOfWork = {
    async transaction({ work }) {
      if (busy) return unwrap({ outcome: deny<never>({ code: "unavailable", message: "Forms transaction busy" }) });
      busy = true;
      const local = structuredClone(state);
      const session: SqlSession = {
        async query() { return unwrap({ outcome: deny<never>({ code: "unavailable", message: "Memory forms storage does not execute SQL" }) }); },
        async transaction(input) { sessionState({ session }); return input.work({ session }); },
      };
      sessions.set(session, local);
      try {
        const result = await work({ session });
        if (!isDenial({ value: result })) state = local;
        return result;
      } finally { sessions.delete(session); busy = false; }
    },
  };
  const publications: FormPublicationPort = {
    append(input, optional) { return formsBoundary<FormPublication>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const publication = unwrap({ outcome: parsePublication({ value: input.publication, context: input.context }) });
      const local = sessionState(input);
      const existing = local.publications.find(item => item.scope.workspaceId === publication.scope.workspaceId &&
        (item.publicationId === publication.publicationId || item.slug === publication.slug && item.version === publication.version));
      if (existing && !samePublication({ left: existing, right: publication })) return deny({ code: "conflict", message: "Publication identity conflict" });
      if (existing) return { ok: true, value: structuredClone(existing) };
      local.publications.push(structuredClone(publication));
      return { ok: true, value: publication };
    } }); },
    find(input, optional) { return formsBoundary<FormPublication | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.publicationId }) });
      const found = state.publications.find(item => item.scope.workspaceId === input.context.scope.workspaceId && item.publicationId === input.publicationId);
      if (!found) return { ok: true, value: null };
      return parsePublication({ value: structuredClone(found), context: input.context });
    } }); },
    findBySlug(input, optional) { return formsBoundary<FormPublication | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.slug }) });
      const found = state.publications.filter(item => item.scope.workspaceId === input.context.scope.workspaceId && item.slug === input.slug).sort((left, right) => right.version - left.version)[0];
      if (!found) return { ok: true, value: null };
      return parsePublication({ value: structuredClone(found), context: input.context });
    } }); },
  };
  const receipts: FormReceiptPort = {
    find(input, optional) { return formsBoundary<SubmissionReceipt | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.publicationId }) });
      unwrap({ outcome: parseBoundary({ schema: idSchema, input: input.attemptId }) });
      return { ok: true, value: structuredClone(sessionState(input).receipts.get(receiptKey(input)) ?? null) };
    } }); },
    append(input, optional) { return formsBoundary<SubmissionReceipt>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const receipt = unwrap({ outcome: parseReceipt({ value: input.receipt }) });
      const local = sessionState(input);
      if (!local.publications.some(item => item.scope.workspaceId === input.context.scope.workspaceId && item.publicationId === receipt.publicationId)) return deny({ code: "unavailable", message: "Receipt publication unavailable" });
      const key = receiptKey({ context: input.context, ...receipt });
      const existing = local.receipts.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) return deny({ code: "conflict", message: "Receipt identity conflict" });
      local.receipts.set(key, structuredClone(receipt));
      return { ok: true, value: receipt };
    } }); },
  };
  const subjects: FormSubjectPort = {
    find(input, optional) { return formsBoundary<FormSubjectReceipt | null>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      idSchema.parse(input.submissionId);
      return { ok: true, value: structuredClone(sessionState(input).subjects.get(JSON.stringify([input.context.scope.workspaceId, input.submissionId])) ?? null) };
    } }); },
    append(input, optional) { return formsBoundary<FormSubjectReceipt>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const receipt = formSubjectSchema.parse(input.receipt);
      const local = sessionState(input);
      const associated = [...local.receipts.values()].some(item => item.submissionId === receipt.submissionId && item.publicationId === receipt.publicationId && local.receipts.get(receiptKey({ context: input.context, ...item })) === item);
      if (!associated) return deny({ code: "unavailable", message: "Acceptance submission unavailable" });
      const key = JSON.stringify([input.context.scope.workspaceId, receipt.submissionId]);
      const prior = local.subjects.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(receipt)) return deny({ code: "conflict", message: "Acceptance receipt conflict" });
      local.subjects.set(key, structuredClone(receipt));
      return { ok: true, value: structuredClone(receipt) };
    } }); },
    list(input, optional) { return formsBoundary<readonly FormSubjectReceipt[]>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      const limit = z.number().int().min(1).max(100).parse(input.limit);
      const items = [...state.subjects.entries()].filter(([key]) => JSON.parse(key)[0] === input.context.scope.workspaceId).map(([, item]) => item);
      items.sort((a, b) => b.acceptedAt - a.acceptedAt || (a.submissionId < b.submissionId ? 1 : -1));
      return { ok: true, value: structuredClone(items.slice(0, limit)) };
    } }); },
    purgeSubject(input, optional) { return formsBoundary<void>({ work: async () => {
      unwrap({ outcome: checkContext(input, optional) });
      idSchema.parse(input.subjectId);
      if (!required.submissions) return deny({ code: "unavailable", message: "Memory submission erasure adapter unavailable" });
      const items = [...state.subjects.entries()].filter(([key, item]) => JSON.parse(key)[0] === input.context.scope.workspaceId && item.subjectId === input.subjectId);
      for (const [, item] of items) {
        const submission = await required.submissions.findAnyById({ workspaceId: input.context.scope.workspaceId, id: item.submissionId });
        if (submission) await required.submissions.save({ ...submission, data: {}, sourceIp: null, deletedAt: submission.deletedAt ?? submission.submittedAt });
      }
      return { ok: true, value: undefined };
    } }); },
  };
  return { publications, receipts, subjects, unitOfWork };
}

/** The UnitOfWork convention rolls back returned denials as well as thrown failures. */
function isDenial(required: { value: unknown }): boolean {
  return typeof required.value === "object" && required.value !== null && "ok" in required.value && required.value.ok === false;
}
