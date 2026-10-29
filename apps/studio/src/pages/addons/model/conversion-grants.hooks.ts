/** Conversion-sharing forms use the existing tool/card/operation transport. */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { z } from 'zod';
import { idSchema, measurementGrantSchema, pageQuerySchema } from '@open-marketing/contracts';
import type { ConfirmationCard, MeasurementGrant, ToolCall } from '@open-marketing/contracts';
import type { IntegrationsPageProps } from './integrations.hooks.js';

const grantFieldsSchema = measurementGrantSchema.omit({ scope: true, kind: true, revoked: true, payloadSchema: true, payloadVersion: true });
const grantPageSchema = z.strictObject({ items: z.array(measurementGrantSchema).max(100), cursor: idSchema.nullable() });
const validDaysSchema = z.number().int().min(1).max(365);

/** One pending operation prevents repeated writes. An approval acknowledgement is never success:
 * Refresh must read completed, then reload the grants. Uncertain outcomes retain their identity.
 * @example useConversionGrants({ api, runtime });
 * @complexity O(p) time/space for p <=100 grants; constant bounded requests per action, no polling.
 */
export function useConversionGrants(required: IntegrationsPageProps) {
  const [items, setItems] = useState<MeasurementGrant[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [card, setCard] = useState<ConfirmationCard | null>(null);
  const operation = useRef<{ id: string; name: string; cardId?: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);

  /** Decode only completed, bounded pages. Malformed/failed reads preserve the last known list. */
  const load = async (input: { cursor?: string } = {}): Promise<void> => {
    const query = pageQuerySchema.parse({ limit: 100, ...input });
    const result = await required.api.tool?.({ call: { name: 'om_measure_grants_list', input: query, operationId: required.runtime.ids.next({}) }, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!result?.ok || result.value.status !== 'completed') throw new Error('Grant list unavailable');
    const page = grantPageSchema.parse(result.value.output);
    setItems(page.items); setCursor(page.cursor); setLoaded(true);
  };
  /** Verify both identities before rendering the server's exact card. */
  const readCard = async (input: { id: string; cardId: string }): Promise<void> => {
    const result = await required.api.approvalCard?.({ cardId: input.cardId, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!result?.ok || result.value.cardId !== input.cardId || result.value.operationId !== input.id) {
      setError('Approval unavailable. Refresh grants to check again.'); return;
    }
    setCard(result.value); setNotice('Review the request, then Refresh grants to check the result.');
  };
  /** Completion and a successful list reload are both required before clearing the retained write. */
  const refreshData = async (): Promise<void> => {
    const active = operation.current;
    if (!active) { await load(); return; }
    const result = await required.api.operation?.({ operationId: active.id, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!result?.ok || result.value.operationId !== active.id) { setError('Operation unavailable. Refresh before another submission.'); return; }
    const value = result.value;
    switch (value.status) {
      case 'completed':
        await load();
        if (controller.current?.signal.aborted) return;
        operation.current = null; setPending(false); setCard(null);
        setNotice(active.name === 'om_measure_grant' ? 'Conversion sharing granted.' : 'Conversion sharing revoked.');
        return;
      case 'pending': {
        const cardId = value.cardId ?? active.cardId;
        if (cardId) await readCard({ id: active.id, cardId });
        return;
      }
      case 'unknown': setCard(null); setError('Outcome unresolved. Refresh before another submission.'); return;
      case 'cancelled': case 'interrupted':
        operation.current = null; setPending(false); setCard(null); setNotice('Request ' + value.status + '.'); return;
    }
  };
  /** Runtime cancellation and a synchronous lock suppress late replies and overlapping writes. */
  const perform = async (input: { work: () => Promise<void> }): Promise<void> => {
    if (lock.current || controller.current?.signal.aborted) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await input.work(); }
    catch { if (!signal?.aborted) setError('Grant response unavailable. Refresh before another submission.'); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  /** Dispatch once; even a completed dispatch response must be verified through operation lookup. */
  const write = async (input: { name: string; input: ToolCall['input'] }): Promise<void> => {
    if (!loaded || operation.current) return;
    const id = required.runtime.ids.next({});
    operation.current = { id, name: input.name }; setPending(true); setCard(null);
    const result = await required.api.tool?.({ call: { ...input, operationId: id }, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!result?.ok) { setError('Outcome unconfirmed. Refresh before another submission.'); return; }
    if (result.value.status === 'pending') operation.current.cardId = result.value.cardId;
    await refreshData();
  };
  useEffect(() => {
    const active = required.runtime.abort(); controller.current = active; lock.current = false;
    void perform({ work: load });
    return () => active.abort();
  }, [required.api, required.runtime]);

  /** Native form ABI; canonical bounds validate plain inputs and server-owned metadata is omitted. */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const days = validDaysSchema.safeParse(Number(form.get('days')));
    if (!days.success) { setError('Valid for days must be between 1 and 365.'); return; }
    const grant = grantFieldsSchema.safeParse({ grantId: required.runtime.ids.next({}), connectionId: form.get('connectionId'),
      destination: form.get('destination'), accountId: form.get('accountId'), purpose: form.get('purpose'),
      definitionIds: String(form.get('definitionIds') ?? '').split(',').map(value => value.trim()),
      expiresAt: required.runtime.clock.now({}) + days.data * 86400000 });
    if (!grant.success) { setError('Enter valid identifiers and 1–16 comma-separated definition IDs.'); return; }
    void perform({ work: () => write({ name: 'om_measure_grant', input: grant.data }) });
  };
  const refresh = (): void => { void perform({ work: refreshData }); };
  const next = (): void => { if (cursor) void perform({ work: () => load({ cursor }) }); };
  const revokeFor = (input: { grantId: string }) => (): void => { void perform({ work: () => write({ name: 'om_measure_revoke_grant', input }) }); };
  const disabled = busy || pending || !loaded || !required.api.operation;
  return { busy, pending, notice, error, card, cursor, submit, refresh, next, disabled,
    rows: items.map(grant => ({ grant, status: grant.revoked ? 'Revoked' : grant.expiresAt <= required.runtime.clock.now({}) ? 'Expired' : 'Active',
      expires: new Date(grant.expiresAt).toLocaleString(), revoke: revokeFor({ grantId: grant.grantId }), disabled: disabled || grant.revoked })) };
}

/** Presentation consumes hook-prepared callbacks; TSX never builds event closures. */
export type ConversionGrantRow = ReturnType<typeof useConversionGrants>['rows'][number];
