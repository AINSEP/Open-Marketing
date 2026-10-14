/** Owner-scoped Jini history; OM settings contain identifiers, never provider credentials. */
import type { ChatStore, ChatStoreFactory, ChatConversation } from '@jini-ai/chat/store';
import { assistantContextSchema, assistantSettingsSchema, conversationListSchema, conversationSchema, parseBoundary } from '@open-marketing/contracts';
import type { AssistantContext, AssistantSettings, AssistantSettingsStatus, CallContext, Conversation, ConversationList, ConversationSummary, IdPort, ObserverPort, Outcome, PageQuery } from '@open-marketing/contracts';
import type { CampaignSqlPort } from '@open-marketing/campaigns';
import type { Integrations } from './integrations.js';
import { localFailure } from './composition/local-auth.js';

/** History/settings are owner HTTP capabilities, not recursive agent tools. */
export interface Conversations {
 store(required: { context: CallContext }): ChatStore;
 create(required: { context: CallContext }): Promise<Outcome<ConversationSummary>>;
 list(required: { context: CallContext; query: PageQuery }): Promise<Outcome<ConversationList>>;
 read(required: { context: CallContext; conversationId: string; query: PageQuery }): Promise<Outcome<Conversation>>;
 settings(required: { context: CallContext }): Promise<Outcome<AssistantSettingsStatus>>;
 setSettings(required: { context: CallContext; settings: AssistantSettings }): Promise<Outcome<AssistantSettingsStatus>>;
 modelContext(required: { context: CallContext; conversationId: string; settings: AssistantSettings }): Promise<Outcome<AssistantContext>>;
}
interface Dependencies { stores: ChatStoreFactory; db: CampaignSqlPort; ids: IdPort; observer: ObserverPort; integrations: Pick<Integrations, 'list'> }
const defaults: AssistantSettings = { mode: 'sandbox', model: 'claude-sonnet-5-5', connectionId: null };
function summary(required: { conversation: ChatConversation }): ConversationSummary {
 const c = required.conversation;
 return { conversationId: c.id, title: c.title ?? 'New chat', createdAt: c.createdAt, updatedAt: c.updatedAt };
}
/** Translate opaque storage errors and report only scoped tracing and fixed operation names. */
export async function conversationBoundary<T>(required: { context: CallContext; observer: ObserverPort; operation: string; work(): Promise<Outcome<T>> }): Promise<Outcome<T>> {
 let result: Outcome<T>;
 try { result = await required.work(); }
 catch { result = localFailure({ message: 'Assistant storage unavailable' }); }
 try { required.observer.observe({ operation: required.operation, outcome: result.ok ? 'ok' : result.error.code,
  correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
 catch { /* Diagnostics cannot alter persisted state. */ }
 return result;
}
/** Inert binding. Every store fixes workspace/owner once; Jini owns pagination and message identity.
 * @example const conversations = createConversations({ stores, db, ids, observer, integrations });
 * @complexity Bounded pages (<=100), model context <=40 messages/128 KiB; no key reads.
 */
export function createConversations(required: Dependencies): Conversations {
 const store = (input: { context: CallContext }): ChatStore => required.stores({ scope: { scopeId: input.context.scope.workspaceId, ownerKind: 'user', ownerId: input.context.scope.ownerId } });
 const boundary = <T>(input: { context: CallContext; operation: string; work(): Promise<Outcome<T>> }) => conversationBoundary({ ...input, observer: required.observer });
 async function settings(input: { context: CallContext }): Promise<Outcome<AssistantSettingsStatus>> {
  return boundary({ ...input, operation: 'assistant.settings.read', work: async () => {
   const rows = await required.db.query({ text: 'SELECT settings_json FROM om_assistant_settings WHERE owner_id=$1 AND workspace_id=$2', values: [input.context.scope.ownerId, input.context.scope.workspaceId] });
   const value = rows.rows[0]?.settings_json;
   const parsed = parseBoundary({ schema: assistantSettingsSchema, input: value === undefined ? defaults : JSON.parse(String(value)) });
   if (!parsed.ok) return parsed;
   return readiness({ context: input.context, settings: parsed.value, integrations: required.integrations });
  } });
 }
 return { store, settings,
  create: input => boundary({ ...input, operation: 'assistant.conversations.create', work: async () => {
   const conversation = await store(input).create({ id: required.ids.next({}), title: 'New chat' });
   return { ok: true, value: summary({ conversation }) };
  } }),
  list: input => boundary({ ...input, operation: 'assistant.conversations.list', work: async () => {
   const page = await store(input).pageConversations({}, input.query);
   return parseBoundary({ schema: conversationListSchema, input: { items: page.items.map(conversation => summary({ conversation })), cursor: page.nextCursor ?? null } });
  } }),
  read: input => boundary({ ...input, operation: 'assistant.conversations.read', work: async () => {
   const owned = store(input); const conversation = await owned.get({ id: input.conversationId });
   if (!conversation) return localFailure({ code: 'forbidden', message: 'Conversation unavailable in owner scope' });
   const page = await owned.pageMessages({ conversationId: input.conversationId }, input.query);
   return parseBoundary({ schema: conversationSchema, input: { conversation: summary({ conversation }),
    messages: page.items.map(message => ({ id: message.id, role: message.role, text: message.content })), cursor: page.nextCursor ?? null } });
  } }),
  setSettings: input => boundary({ ...input, operation: 'assistant.settings.write', work: async () => {
   const parsed = parseBoundary({ schema: assistantSettingsSchema, input: input.settings });
   if (!parsed.ok) return parsed;
   if (!['claude-sonnet-5-5', 'claude-opus-5-5'].includes(parsed.value.model)) return localFailure({ code: 'invalid_input', message: 'Unknown assistant model' });
   await required.db.query({ text: 'INSERT INTO om_assistant_settings(owner_id,workspace_id,settings_json) VALUES ($1,$2,$3) ON CONFLICT(owner_id,workspace_id) DO UPDATE SET settings_json=excluded.settings_json',
    values: [input.context.scope.ownerId, input.context.scope.workspaceId, JSON.stringify(parsed.value)] });
   return settings(input);
  } }),
  modelContext: input => boundary({ ...input, operation: 'assistant.context', work: async () => {
   const owned = store(input);
   if (!await owned.get({ id: input.conversationId })) return localFailure({ code: 'forbidden', message: 'Conversation unavailable' });
   // Jini's history reader returns the tail when fromPosition is omitted; omit the current queued turn.
   const page = await owned.history?.read({ chatId: input.conversationId }, { limit: 42 });
   if (!page) return localFailure({ message: 'Bounded conversation history unavailable' });
   const messages = page.messages.filter(message => !['queued', 'running'].includes(message.runStatus ?? ''))
    .slice(-40).map(message => ({ id: message.id, role: message.role, text: message.content }));
   return parseBoundary({ schema: assistantContextSchema, input: { settings: input.settings, messages } });
  } }),
 };
}
/** Saved connection metadata is sufficient for readiness; decryption happens only at model dispatch. */
async function readiness(required: { context: CallContext; settings: AssistantSettings; integrations: Pick<Integrations, 'list'> }): Promise<Outcome<AssistantSettingsStatus>> {
 if (required.settings.mode === 'sandbox') return { ok: true, value: { settings: required.settings, ready: true, status: 'sandbox' } };
 const listed = await required.integrations.list({ context: required.context, query: { limit: 100 } });
 if (!listed.ok) return { ok: true, value: { settings: required.settings, ready: false, status: 'unavailable' } };
 const candidates = listed.value.items.filter(item => item.pluginId === 'anthropic' && (required.settings.connectionId === null || item.connectionId === required.settings.connectionId));
 const connection = candidates.length === 1 ? candidates[0] : undefined;
 const status = connection?.status === 'saved' ? 'ready' : connection?.status === 'reconnect_required' ? 'reconnect_required' : 'disconnected';
 return { ok: true, value: { settings: required.settings, ready: status === 'ready', status } };
}
