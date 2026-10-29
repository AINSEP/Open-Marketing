/** Jini durable acceptance/transcripts plus OM-scoped event observation. No billed request is replayed. */
import { createRunAcceptance } from '@jini-ai/chat/server/durable-runs';
import type { DurableRunStore } from '@jini-ai/chat/server/durable-runs';
import type { ChatRunLedger, ChatDatabase as JiniDatabase } from '@jini-ai/chat/store/runtime';
import type { StorageKernel } from '@jini-ai/db/kernel';
import { sniffContentType } from '@jini-ai/cms/media';
import type { MediaLibrary } from '@open-marketing/media-library';
import { chatAttachmentSchema, assistantContextSchema, callContextSchema, parseBoundary, runEventSchema } from '@open-marketing/contracts';
import type { ChatAttachmentRef, AssistantContext, CallContext, ClockPort, IdPort, ObserverPort, Outcome, RunEvent, RunGrantMetadata } from '@open-marketing/contracts';
import type { Conversations } from './conversations.js';
import { conversationBoundary } from './conversations.js';
import { localFailure } from './composition/local-auth.js';
import type { OwnerRunPort } from './ports.js';

/** Extra tables belong to the server; Jini borrows the same host-owned kernel. */
export type AssistantDatabase = JiniDatabase & {
 om_assistant_runs: { run_id: string; owner_id: string; workspace_id: string; conversation_id: string; message_id: string;
  context_json: string; settings_json: string; status: 'running' | 'completed' | 'cancelled' | 'interrupted'; expires_at: number; retained_bytes: number };
 om_assistant_events: { run_id: string; sequence: number; event_id: string; event_json: string };
};
type Receipt = Awaited<ReturnType<OwnerRunPort['start']>>;
type LaunchInput = { runId: string; conversationId: string; mode: 'sandbox' | 'model'; expiresAt: number };
/** Extends the existing process controller; scope, grants and revocation stay with OM. */
export interface AssistantRuns {
 start(required: { context: CallContext; prompt: string; attachments?: ChatAttachmentRef[]; conversationId?: string; launch(required: LaunchInput): Promise<Receipt> }): Promise<Receipt>;
 record(required: { context: CallContext; event: RunEvent }): Promise<Outcome<void>>;
 events(required: { context: CallContext; runId: string; after: number }): ReturnType<OwnerRunPort['events']>;
 context(required: { grant: RunGrantMetadata }): Promise<Outcome<AssistantContext | { mode: 'local-sandbox' }>>;
 initialize(required: { context: CallContext }): Promise<Outcome<void>>;
}
interface Dependencies { media: Pick<MediaLibrary, 'readImage'>; kernel: StorageKernel<AssistantDatabase>; durable: DurableRunStore; ledger: ChatRunLedger; conversations: Conversations; clock: ClockPort; ids: IdPort; observer: ObserverPort }
type RunRow = AssistantDatabase['om_assistant_runs'];

/** Stored authority is scope-bound on every read. Tokens are never persisted. */
async function ownedRun(required: { deps: Dependencies; context: CallContext; runId: string }): Promise<RunRow | undefined> {
 return required.deps.kernel.run(db => db.selectFrom('om_assistant_runs').selectAll().where('run_id', '=', required.runId)
  .where('owner_id', '=', required.context.scope.ownerId).where('workspace_id', '=', required.context.scope.workspaceId).executeTakeFirst());
}
function finalStatus(required: { kind: RunEvent['kind'] }): RunRow['status'] {
 switch (required.kind) { case 'ended': return 'completed'; case 'cancelled': return 'cancelled'; case 'error': return 'interrupted'; default: return 'running'; }
}
/** Cursor pages stay <=128 events and <=192 KiB so the existing HTTP response cap remains honest. */
async function page(required: { deps: Dependencies; row: RunRow; after: number }): ReturnType<OwnerRunPort['events']> {
 const rows = await required.deps.kernel.run(db => db.selectFrom('om_assistant_events').select('event_json').where('run_id', '=', required.row.run_id)
  .where('sequence', '>', required.after).orderBy('sequence').limit(128).execute());
 const events: RunEvent[] = []; let bytes = 0;
 for (const row of rows) {
  bytes += Buffer.byteLength(row.event_json);
  if (bytes > 196608) break;
  const parsed = parseBoundary({ schema: runEventSchema, input: JSON.parse(row.event_json) });
  if (!parsed.ok) return parsed;
  events.push(parsed.value);
 }
 // A terminal DB row may still have multiple cursor pages waiting to be read.
 const tail = events.at(-1);
 const status = tail && tail.kind !== 'ended' && tail.kind !== 'cancelled' && tail.kind !== 'error' ? 'running' : required.row.status;
 const usage = await runUsage({ deps: required.deps, context: callContextSchema.parse(JSON.parse(required.row.context_json)), row: required.row });
 if (!usage.ok) return usage;
 return { ok: true, value: { runId: required.row.run_id, status, events, ...(usage.value ? { usage: usage.value } : {}) } };
}

/** No recovery engine is enabled: old authority is interrupted, saved work remains readable.
 * @example const runs = createAssistantRuns({ kernel, durable, ledger, conversations, media, clock, ids, observer });
 * @complexity <=8,192 events/2 MiB per run; indexed reads and one locked transaction per accepted event.
 */
export function createAssistantRuns(required: Dependencies): AssistantRuns {
 const boundary = <T>(input: { context: CallContext; operation: string; work(): Promise<Outcome<T>> }) => conversationBoundary({ ...input, observer: required.observer });
 return {
  start: input => boundary({ context: input.context, operation: 'assistant.run.accept', work: () => startAssistantRun({ deps: required, ...input }) }),
  record: input => boundary({ ...input, operation: 'assistant.event.persist', work: () => persistEvent({ deps: required, ...input }) }),
  events: input => boundary({ ...input, operation: 'assistant.events.read', work: async () => {
   const row = await ownedRun({ deps: required, ...input });
   if (!row) return localFailure({ code: 'forbidden', message: 'Run unavailable in owner scope' });
   if (row.status === 'running' && row.expires_at <= required.clock.now({})) await interruptRun({ deps: required, context: input.context, row });
   return page({ deps: required, row: (await ownedRun({ deps: required, ...input }))!, after: input.after });
  } }),
  context: async input => {
   const context: CallContext = { scope: input.grant.scope, principal: { kind: 'agent', runId: input.grant.runId, agentInstanceId: input.grant.agentInstanceId }, correlationId: input.grant.grantId, traceId: input.grant.grantId };
   return boundary({ context, operation: 'assistant.context.read', work: async () => {
    const row = await ownedRun({ deps: required, context, runId: input.grant.runId });
    if (!row || row.status !== 'running') return localFailure({ code: 'forbidden', message: 'Run context unavailable' });
    const parsed = parseBoundary({ schema: assistantContextSchema, input: JSON.parse(row.settings_json) });
    if (!parsed.ok) return localFailure({ message: 'Run context unavailable' });
    if (parsed.value.settings.mode === 'sandbox') return { ok: true, value: { mode: 'local-sandbox' as const } };
    return resolveRunImages({ deps: required, context, frozen: parsed.value });
   } });
  },
  initialize: input => boundary({ ...input, operation: 'assistant.runs.interrupt', work: async () => {
   // Bounded boot batches interrupt, never reissue a model request or restore a token.
   while (true) {
    const rows = await required.kernel.run(db => db.selectFrom('om_assistant_runs').selectAll().where('status', '=', 'running').limit(100).execute());
    if (!rows.length) break;
    for (const row of rows) {
     const context = callContextSchema.parse(JSON.parse(row.context_json));
     await interruptRun({ deps: required, context, row });
    }
   }
   return { ok: true, value: undefined };
  } }),
 };
}

/** Resolve saved scope/settings before reserving a conversation slot; model failures never fall back. */
async function prepareRun(required: { deps: Dependencies; context: CallContext; requestedConversationId?: string }): Promise<Outcome<{ conversationId: string; modelContext: AssistantContext }>> {
 const { deps, context, requestedConversationId } = required;

   const settings = await deps.conversations.settings({ context });
   if (!settings.ok) return settings;
   if (!settings.value.ready) return localFailure({ message: 'Selected model connection is not ready. Choose Sandbox or reconnect in Integrations.' });
   const conversation = requestedConversationId ? await deps.conversations.store({ context }).get({ id: requestedConversationId }) : null;
   if (requestedConversationId && !conversation) return localFailure({ code: 'forbidden', message: 'Conversation unavailable in owner scope' });
   const created = conversation ? { ok: true as const, value: { conversationId: conversation.id } } : await deps.conversations.create({ context });
   if (!created.ok) return created;
   const conversationId = created.value.conversationId;
   const contextResult = await deps.conversations.modelContext({ context, conversationId, settings: settings.value.settings });
   if (!contextResult.ok) return contextResult;
   return { ok: true, value: { conversationId, modelContext: contextResult.value } };
}
/** Acceptance and OM cursor metadata share one kernel transaction. The Jini launch callback only
 * records dispatch identity here; effects run after this function commits.
 */
async function acceptRun(required: { deps: Dependencies; context: CallContext; prompt: string; conversationId: string; modelContext: AssistantContext }): Promise<LaunchInput> {
 const { deps, context, prompt, conversationId, modelContext } = required;
   let dispatch: LaunchInput | undefined;
   const acceptance = createRunAcceptance({ store: deps.durable, now: () => deps.clock.now({}), mintRunId: () => deps.ids.next({}),
    sanitizeContextRef: value => value.contextRef, attach() {}, async launch({ run }) {
     const expiresAt = deps.clock.now({}) + 300000;
     await deps.kernel.run(db => db.insertInto('om_assistant_runs').values({ run_id: run.runId, owner_id: context.scope.ownerId,
      workspace_id: context.scope.workspaceId, conversation_id: conversationId, message_id: run.messageId,
      context_json: JSON.stringify(context), settings_json: JSON.stringify(modelContext), status: 'running', expires_at: expiresAt, retained_bytes: 0 }).execute());
     dispatch = { runId: run.runId, conversationId, mode: modelContext.settings.mode, expiresAt };
    } });
   // Jini accepts the logical turn; its launch hook only records OM metadata in this transaction.
   // The actual process request follows commit, so callbacks never wait on an HTTP-held DB lock.
   await deps.kernel.transaction(async () => {
   await acceptance.accept({ principalId: context.scope.ownerId, workspaceId: context.scope.workspaceId, conversationId,
    messageId: deps.ids.next({}), request: { agentId: 'om', contextRef: JSON.stringify({ userMessage: { id: deps.ids.next({}), role: 'user', content: prompt, attachments: modelContext.attachments, createdAt: deps.clock.now({}) } }) } });
   if (!dispatch) throw new Error('Run metadata acceptance failed');
   });
   return dispatch!;
}
async function startAssistantRun(required: { deps: Dependencies } & Parameters<AssistantRuns['start']>[0]): Promise<Receipt> {
 const prepared = await prepareRun({ deps: required.deps, context: required.context, requestedConversationId: required.conversationId });
 if (!prepared.ok) return prepared;
 const attachments = await acceptAttachments({ deps: required.deps, context: required.context, attachments: required.attachments, mode: prepared.value.modelContext.settings.mode });
 if (!attachments.ok) return attachments;
 const modelContext = { ...prepared.value.modelContext, ...(attachments.value.length ? { attachments: attachments.value } : {}) };
 const dispatch = await acceptRun({ deps: required.deps, context: required.context, prompt: required.prompt, conversationId: prepared.value.conversationId, modelContext });
 const receipt = await required.launch(dispatch);
 if (!receipt.ok) {
  const row = await ownedRun({ deps: required.deps, context: required.context, runId: dispatch.runId });
  if (row) await interruptRun({ deps: required.deps, context: required.context, row });
 }
 return receipt;
}

/** Current-turn references are validated before durable acceptance or process/model launch.
 * At most four scoped byte reads; invalid batches accept no logical user turn. @complexity O(total bytes), <=4 MiB returned.
 */
async function acceptAttachments(required: { deps: Dependencies; context: CallContext; attachments?: ChatAttachmentRef[]; mode: 'sandbox' | 'model' }): Promise<Outcome<ChatAttachmentRef[]>> {
 const parsed = chatAttachmentSchema.array().max(4).safeParse(required.attachments ?? []);
 if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid attachment.' });
 if (parsed.data.length && required.mode === 'sandbox') return localFailure({ code: 'invalid_input', message: 'Image attachments need a model connection.' });
 const refs: ChatAttachmentRef[] = [];
 for (const ref of parsed.data) {
  const image = await readRunImage({ ...required, ref });
  if (!image.ok) return localFailure({ code: 'invalid_input', message: 'Invalid attachment.' });
  refs.push(image.value.ref);
 }
 return { ok: true, value: refs };
}
const imageExtensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' } as const;
/** Canonical name comes from the stored media record, never the caller's ref: the immutable upload name when
 * the media service keeps one, else the stored title plus the extension of the sniffed format. O(1). */
function canonicalImageName(required: { record: { originalFilename?: string | null; title: string }; mimeType: keyof typeof imageExtensions }): string {
 if (required.record.originalFilename) return required.record.originalFilename;
 const extension = imageExtensions[required.mimeType];
 return /\.(png|jpe?g|webp)$/i.test(required.record.title) ? required.record.title : required.record.title + extension;
}
/** Shared acceptance/context read: the media adapter enforces owner/workspace scope and active state.
 * Format comes from stored bytes, never a header or extension. @complexity O(bytes), <=1 MiB returned.
 */
async function readRunImage(required: { deps: Dependencies; context: CallContext; ref: ChatAttachmentRef }): Promise<Outcome<{ ref: ChatAttachmentRef; image: NonNullable<AssistantContext['images']>[number] }>> {
 const read = await required.deps.media.readImage({ context: required.context, assetId: required.ref.path, maxBytes: 1048576 });
 if (!read.ok) return read;
 const { asset, bytes } = read.value;
 const mimeType = sniffContentType({ bytes });
 if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') return localFailure({ code: 'invalid_input', message: 'Invalid attachment.' });
 const ref = chatAttachmentSchema.safeParse({ path: asset.record.id, name: canonicalImageName({ record: asset.record, mimeType }), kind: 'image', size: bytes.length });
 if (!ref.success || asset.record.id !== required.ref.path || asset.record.workspaceId !== required.context.scope.workspaceId) return localFailure({ code: 'invalid_input', message: 'Invalid attachment.' });
 return { ok: true, value: { ref: ref.data, image: { mimeType, data: Buffer.from(bytes).toString('base64') } } };
}
/** Resolve only references frozen into this run; history images are deliberately deferred.
 * Any missing/trashed/refused asset makes the entire context unavailable. @complexity <=4 reads/4 MiB.
 */
async function resolveRunImages(required: { deps: Dependencies; context: CallContext; frozen: AssistantContext }): Promise<Outcome<AssistantContext>> {
 if (!required.frozen.attachments?.length) return { ok: true, value: required.frozen };
 const images: NonNullable<AssistantContext['images']> = [];
 for (const ref of required.frozen.attachments ?? []) {
  const read = await readRunImage({ ...required, ref });
  if (!read.ok) return localFailure({ message: 'Run context unavailable' });
  images.push(read.value.image);
 }
 const parsed = assistantContextSchema.safeParse({ ...required.frozen, images });
 if (!parsed.success) return localFailure({ message: 'Run context unavailable' });
 return { ok: true, value: parsed.data };
}

/** Duplicate identity must match byte-for-byte; event cursor and transcript commit together.
 * No partial mutation on gaps, wrong scope, terminal writes or retained-byte exhaustion.
 */
async function persistEvent(required: { deps: Dependencies; context: CallContext; event: RunEvent }): Promise<Outcome<void>> {
 return required.deps.kernel.transaction(async () => {
  await required.deps.kernel.lockKey('om-run:' + required.event.runId);
  const row = await ownedRun({ ...required, runId: required.event.runId });
  if (!row) return localFailure({ code: 'forbidden', message: 'Run unavailable' });
  const storedContext = callContextSchema.parse(JSON.parse(row.context_json));
  if (required.event.correlationId !== storedContext.correlationId || required.event.traceId !== storedContext.traceId) return localFailure({ code: 'invalid_input', message: 'Event tracing scope differs from accepted run' });
  const serialized = JSON.stringify(required.event);
  const previous = await required.deps.kernel.run(db => db.selectFrom('om_assistant_events').select('event_json').where('run_id', '=', row.run_id)
   .where(({ eb, or }) => or([eb('sequence', '=', required.event.sequence), eb('event_id', '=', required.event.eventId)])).executeTakeFirst());
  if (previous) return previous.event_json === serialized ? { ok: true, value: undefined } : localFailure({ code: 'conflict', message: 'Conflicting run event identity' });
  if (row.status !== 'running') return localFailure({ code: 'expired', message: 'Run already terminal' });
  const last = await required.deps.kernel.run(db => db.selectFrom('om_assistant_events').select('sequence').where('run_id', '=', row.run_id).orderBy('sequence', 'desc').limit(1).executeTakeFirst());
  if (required.event.sequence !== (last?.sequence ?? 0) + 1) return localFailure({ code: 'conflict', message: 'Event cursor gap' });
  const bytes = Buffer.byteLength(serialized); const status = finalStatus({ kind: required.event.kind });
  if (!eventFits({ sequence: required.event.sequence, status, retainedBytes: row.retained_bytes, eventBytes: bytes })) return localFailure({ code: 'limit_exceeded', message: 'Run retained event limit exceeded' });
  await required.deps.kernel.run(db => db.insertInto('om_assistant_events').values({ run_id: row.run_id, sequence: required.event.sequence, event_id: required.event.eventId, event_json: serialized }).execute());
  await required.deps.kernel.run(db => db.updateTable('om_assistant_runs').set({ status, retained_bytes: row.retained_bytes + bytes }).where('run_id', '=', row.run_id).execute());
  await projectMessage({ ...required, row, status });
  return { ok: true, value: undefined };
 });
}
/** Reserve the final slot and 2 KiB for server-owned terminal evidence. */
function eventFits(required: { sequence: number; status: RunRow['status']; retainedBytes: number; eventBytes: number }): boolean {
 const limit = required.status === 'running' ? { events: 8191, bytes: 2095104 } : { events: 8192, bytes: 2097152 };
 return required.sequence <= limit.events && required.retainedBytes + required.eventBytes <= limit.bytes;
}
/** Jini owns terminal absorption. Streaming updates use its guarded write, avoiding checkpoint's
 * library-owned wall clock; all OM timestamps come from the injected clock.
 */
async function projectMessage(required: { deps: Dependencies; context: CallContext; event: RunEvent; row: RunRow; status: RunRow['status'] }): Promise<void> {
 const store = required.deps.conversations.store(required);
 const saved = await required.deps.durable.find({ runId: required.row.run_id, principalId: required.context.scope.ownerId }, {});
 if (!saved) throw new Error('Missing accepted assistant turn');
 const content = saved.message.content + deltaText({ event: required.event });
 if (content.length > 65536) throw new Error('Assistant message bound exceeded');
 const usage = await runUsage(required);
 if (!usage.ok) throw new Error('Model usage storage unavailable');
 const durationMs = Math.max(0, required.deps.clock.now({}) - (saved.message.startedAt ?? saved.message.createdAt ?? required.deps.clock.now({})));
 const events = [...(saved.message.events ?? []).filter(event => event.kind !== 'usage'), ...(usage.value ? [{ ...usage.value, durationMs }] : [])];
 const ref = { conversationId: required.row.conversation_id, messageId: required.row.message_id, runId: required.row.run_id };
 if (required.status !== 'running') {
  await required.deps.ledger.settle({ ...ref, content, events, status: required.status === 'completed' ? 'succeeded' : required.status === 'cancelled' ? 'canceled' : 'failed', endedAt: required.deps.clock.now({}) });
  return;
 }
 await required.deps.ledger.unlessSettled({ run: ref, write: async () => {
  await store.appendMessage({ conversationId: ref.conversationId, message: { ...saved.message, content, events, runStatus: 'running' } });
 } });
}
/** Only delta events extend the saved assistant text; other payloads contribute nothing. */
function deltaText(required: { event: RunEvent }): string {
 const payload = required.event.payload;
 if (required.event.kind !== 'delta') return '';
 return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && typeof payload.text === 'string' ? payload.text : '';
}
async function interruptRun(required: { deps: Dependencies; context: CallContext; row: RunRow }): Promise<void> {
 if (required.row.status !== 'running') return;
 const last = await required.deps.kernel.run(db => db.selectFrom('om_assistant_events').select('sequence').where('run_id', '=', required.row.run_id).orderBy('sequence', 'desc').limit(1).executeTakeFirst());
 const result = await persistEvent({ ...required, event: { protocolVersion: 1, eventId: required.deps.ids.next({}), runId: required.row.run_id,
  sequence: (last?.sequence ?? 0) + 1, correlationId: required.context.correlationId, traceId: required.context.traceId, kind: 'error', payload: { code: 'unavailable' } } });
 if (!result.ok) throw new Error('Interrupted run persistence failed');
}

/** Sandbox turns carry no model charge. Model summaries come only from the server evidence. */
async function runUsage(required: { deps: Dependencies; context: CallContext; row: RunRow }) {
 const settings = assistantContextSchema.parse(JSON.parse(required.row.settings_json)).settings;
 if (settings.mode === 'sandbox') return { ok: true as const, value: undefined };
 return required.deps.conversations.usage({ context: required.context, runId: required.row.run_id });
}
