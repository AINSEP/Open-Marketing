/** Owner-started single message: exact phone lookup, server segment preview and the existing send card. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { z } from 'zod';
import { idSchema } from '@open-marketing/contracts';
import type { ConfirmationCard, Outcome, ToolCall, ToolOperation, ToolResult } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

const connectionSchema = z.strictObject({ pluginId: idSchema, connectionId: idSchema, accountId: idSchema, channel: z.string().min(1).max(64),
  inboundWebhookUrl: z.url({ protocol: /^https$/ }).max(2048).nullable() });
const connectionsSchema = z.strictObject({ items: z.array(connectionSchema).max(100) });
const contactSchema = z.looseObject({ subjectId: idSchema });
const previewSchema = z.strictObject({ segments: z.number().int().positive().nullable() });
const centsSchema = z.coerce.number().int().positive().max(100000000);
export type MessageConnection = z.infer<typeof connectionSchema>;
export type MessageComposerProps = { api: StudioApiPort; runtime: StudioRuntime; connections: readonly MessageConnection[]; connectionsError?: string };
type ToolProps = { api: StudioApiPort; runtime: StudioRuntime };

function unavailable(required: { message: string }): Outcome<never> {
  return { ok: false, error: { code: 'unavailable', message: required.message, retryable: false } };
}

/** One bounded completed-read call; a 25s runtime deadline aborts it. No retries or polling. */
async function readTool(required: ToolProps & { name: string; input: ToolCall['input']; signal?: AbortSignal }): Promise<Outcome<unknown>> {
  const controller = required.runtime.abort();
  const forward = () => controller.abort();
  required.signal?.addEventListener('abort', forward, { once: true });
  const handle = required.runtime.timers.schedule({ delayMs: 25000, callback: forward });
  try {
    const result = await required.api.tool?.({ call: { name: required.name, input: required.input, operationId: required.runtime.ids.next({}) }, signal: controller.signal });
    if (!result?.ok) return unavailable({ message: result?.error.message ?? 'Messaging is unavailable on this server.' });
    return result.value.status === 'completed' ? { ok: true, value: result.value.output } : unavailable({ message: 'Messaging read unavailable.' });
  } catch { return unavailable({ message: 'Messaging read unavailable.' }); }
  finally { required.runtime.timers.cancel({ handle }); required.signal?.removeEventListener('abort', forward); }
}

/** Messaging connections with server-computed callback URLs; a failed or malformed read is a typed failure, never an empty list.
 * @example const read = await readMessageConnections({ api, runtime, signal });
 */
export async function readMessageConnections(required: ToolProps & { signal?: AbortSignal }): Promise<Outcome<MessageConnection[]>> {
  const result = await readTool({ ...required, name: 'om_message_connections', input: {} });
  if (!result.ok) return result;
  const parsed = connectionsSchema.safeParse(result.value);
  return parsed.success ? { ok: true, value: parsed.data.items } : unavailable({ message: 'Messaging connections response invalid.' });
}
/** Stable identity of a connection; list position is never used. */
export function connectionKey(required: { connection: Pick<MessageConnection, 'pluginId' | 'connectionId' | 'accountId'> }): string {
  const { pluginId, connectionId, accountId } = required.connection;
  return pluginId + '/' + connectionId + '/' + accountId;
}
/** The server's fixed not-found wording for contacts resolve; anything else is a lookup failure. */
const NO_CONTACT = 'Subject not found';

/** Composer form state. Sends exactly once per operation ID; unknown outcomes stay locked for reconciliation.
 * @example useMessageComposer({ api, runtime, connections });
 * @complexity O(connections) render; at most two reads and one send call per submission.
 */
export function useMessageComposer(required: MessageComposerProps) {
  const [phone, setPhone] = useState('');
  const [contact, setContact] = useState<{ subjectId: string; phone: string } | null>(null);
  const [connection, setConnection] = useState('');
  const [content, setContent] = useState('');
  const [segments, setSegments] = useState<number | null>(null);
  const [purpose, setPurpose] = useState('');
  const [intent, setIntent] = useState<'marketing' | 'transactional'>('marketing');
  const [maxCost, setMaxCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [card, setCard] = useState<ConfirmationCard | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => { const active = required.runtime.abort(); controller.current = active; lock.current = false; return () => active.abort(); }, [required.api, required.runtime]);
  /** Pin the first connection by id once the list arrives, so a reordered refresh cannot change the target. */
  useEffect(() => { if (!connection && required.connections[0]) setConnection(connectionKey({ connection: required.connections[0] })); }, [required.connections, connection]);
  const selected = required.connections.find(row => connectionKey({ connection: row }) === connection) ?? null;
  /** Serialize every action behind one busy flag; teardown suppresses late updates. */
  const perform = async (input: { work(required: { signal?: AbortSignal }): Promise<void> }): Promise<void> => {
    if (lock.current) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true); setStatus('');
    try { await input.work({ signal }); }
    catch { if (!signal?.aborted) setStatus('Messaging response unavailable.'); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  const lookup = (): void => { void perform({ work: async ({ signal }) => {
    setContact(null);
    const result = await readTool({ ...required, signal, name: 'om_contacts_resolve', input: { identifier: { kind: 'phone', raw: phone.trim() } } });
    const parsed = contactSchema.safeParse(result.ok ? result.value : null);
    if (signal?.aborted) return;
    if (!result.ok && result.error.message === NO_CONTACT) { setStatus('No OM contact for this phone number.'); return; }
    if (!parsed.success) { setStatus('Contact lookup failed. Try again.'); return; }
    setContact({ subjectId: parsed.data.subjectId, phone: phone.trim() });
  } }); };
  const readPreview = async ({ signal }: { signal?: AbortSignal }): Promise<void> => {
    setSegments(null);
    if (!selected || !content) return;
    const { pluginId, connectionId, accountId } = selected;
    const result = await readTool({ ...required, signal, name: 'om_message_preview', input: { pluginId, connectionId, accountId, content } });
    const parsed = previewSchema.safeParse(result.ok ? result.value : null);
    if (!signal?.aborted && parsed.success) setSegments(parsed.data.segments);
  };
  const preview = (): void => { void perform({ work: readPreview }); };
  /** Card identity must match the frozen operation before it renders Allow/Cancel. */
  const applyResult = async (input: { id: string; value: ToolResult | ToolOperation; signal?: AbortSignal }): Promise<void> => {
    const value = input.value;
    if (value.status === 'pending' && value.cardId) {
      const pending = await required.api.approvalCard?.({ cardId: value.cardId, signal: input.signal });
      if (pending?.ok && pending.value.operationId === input.id) { setCard(pending.value); return; }
      setStatus('Approval card unavailable. Check status.'); return;
    }
    setCard(null);
    setStatus(operationStatus({ value }));
    if (value.status !== 'pending' && value.status !== 'unknown') setOperationId(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const request = sendInput({ contact, selected, content, purpose, intent, maxCost });
    if (!request) { setStatus('Choose a contact and connection, then enter text, consent purpose and a whole-cent maximum.'); return; }
    void perform({ work: async ({ signal }) => {
      await readPreview({ signal });
      const id = required.runtime.ids.next({});
      setOperationId(id);
      const result = await required.api.tool?.({ call: { name: 'om_message_send', operationId: id, input: { operationId: id, ...request } }, signal });
      if (signal?.aborted) return;
      if (!result?.ok) { setOperationId(null); setStatus(result?.error.message ?? 'Messaging is unavailable on this server.'); return; }
      await applyResult({ id, value: result.value, signal });
    } });
  };
  const checkStatus = (): void => { if (operationId) void perform({ work: async ({ signal }) => {
    const result = await required.api.operation?.({ operationId, signal });
    if (signal?.aborted) return;
    if (!result?.ok) { setStatus('Send status unavailable.'); return; }
    await applyResult({ id: operationId, value: result.value, signal });
  } }); };
  const changeText = (event: ChangeEvent<HTMLTextAreaElement>): void => { setContent(event.currentTarget.value); setSegments(null); };
  return { phone, contact, connection, content, segments, purpose, intent, maxCost, busy, status, card, operationId,
    locked: busy || operationId !== null, options: required.connections.map(row => ({ key: connectionKey({ connection: row }), label: row.channel + ' · ' + row.pluginId + ' · ' + row.connectionId })),
    changePhone: (event: ChangeEvent<HTMLInputElement>): void => { setPhone(event.currentTarget.value); setContact(null); },
    changeConnection: (event: ChangeEvent<HTMLSelectElement>): void => { setConnection(event.currentTarget.value); setSegments(null); },
    changeText, changePurpose: (event: ChangeEvent<HTMLInputElement>): void => { setPurpose(event.currentTarget.value); },
    changeIntent: (event: ChangeEvent<HTMLSelectElement>): void => { setIntent(event.currentTarget.value === 'transactional' ? 'transactional' : 'marketing'); },
    changeMaxCost: (event: ChangeEvent<HTMLInputElement>): void => { setMaxCost(event.currentTarget.value); },
    lookup, preview, submit, checkStatus };
}

/** Freeze the exact send arguments; maxCost is integer USD cents (existing money contract). */
function sendInput(required: { contact: { phone: string } | null; selected: MessageConnection | null; content: string; purpose: string; intent: 'marketing' | 'transactional'; maxCost: string }) {
  const cents = centsSchema.safeParse(required.maxCost);
  const purpose = idSchema.safeParse(required.purpose.trim());
  if (!required.contact || !required.selected || !required.content || !cents.success || !purpose.success) return null;
  const { pluginId, connectionId, accountId } = required.selected;
  return { pluginId, connectionId, accountId, recipient: required.contact.phone, purpose: purpose.data, intent: required.intent,
    message: { content: required.content }, maxCost: { currency: 'USD', minorUnits: cents.data } };
}
/** Fixed operator wording; unknown never invites a resend. */
function operationStatus(required: { value: ToolResult | ToolOperation }): string {
  const value = required.value;
  if (value.status === 'completed') {
    const output = z.looseObject({ status: z.string().max(64), reason: z.string().max(256).optional() }).safeParse(value.output);
    return output.success ? 'Send ' + output.data.status + (output.data.reason ? ': ' + output.data.reason : '') + '.' : 'Send completed.';
  }
  const labels = { pending: 'Awaiting approval. Check status after answering.', cancelled: 'Send cancelled.', interrupted: 'Send interrupted. Start a new message.',
    unknown: 'Send outcome unknown. Do not resend; check status to reconcile.' };
  return labels[value.status];
}
