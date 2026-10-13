/** Transaction-local OM storage double. Its unit covers publications/receipts only. */
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { FormPublicationPort, FormReceiptPort } from "./ports.js";
import type { FormPublication, SubmissionReceipt } from "./types.js";
import { checkContext, deny, parsePublication, parseReceipt, samePublication } from "./rules.js";
import { formsBoundary, unwrap } from "./jini.js";

interface State { publications: FormPublication[]; receipts: Map<string, SubmissionReceipt> }

function receiptKey(required: { context: CallContext; publicationId: string; attemptId: string }): string {
  return JSON.stringify([required.context.scope.workspaceId, required.publicationId, required.attemptId]);
}

/** Inert memory storage; concurrent roots fail busy, expired/foreign sessions fail closed.
 * Clones prevent callers mutating immutable evidence. O(n) transaction snapshot for n stored rows.
 * Composition must coordinate other memory participants; this unit cannot roll back Jini rows.
 * @example const storage = createMemoryFormsStorage({}); */
export function createMemoryFormsStorage(_required: Record<string, never>): { publications: FormPublicationPort; receipts: FormReceiptPort; unitOfWork: UnitOfWork } {
  let state: State = { publications: [], receipts: new Map() };
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
  return { publications, receipts, unitOfWork };
}

/** The UnitOfWork convention rolls back returned denials as well as thrown failures. */
function isDenial(required: { value: unknown }): boolean {
  return typeof required.value === "object" && required.value !== null && "ok" in required.value && required.value.ok === false;
}
