/** Brand presentation and the existing tool/card/operation lifecycle; the server owns validation. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { z } from 'zod';
import type { ConfirmationCard, ToolCall } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

/** Widget-local display shape. Opaque visual/asset values must survive text edits unchanged. */
const kitDisplaySchema = z.object({
  business: z.object({ name: z.string(), facts: z.array(z.string()) }),
  offers: z.array(z.object({ name: z.string(), facts: z.array(z.string()) })),
  audience: z.object({ pains: z.array(z.string()), goals: z.array(z.string()) }),
  voice: z.object({ use: z.array(z.string()), avoid: z.array(z.string()) }),
  prohibitedClaims: z.array(z.string()), colours: z.array(z.json()), fonts: z.array(z.json()),
  logoAssetIds: z.array(z.json()), assetIds: z.array(z.json()),
});
const revisionDisplaySchema = z.object({ revision: z.number(), status: z.enum(['draft', 'confirmed']), at: z.number(), kit: kitDisplaySchema });
type DisplayKit = z.infer<typeof kitDisplaySchema>;
type DisplayRevision = z.infer<typeof revisionDisplaySchema>;
/** Dependencies come from WorkspaceCanvas; sample mode performs no requests. */
export interface BrandProfileProps { api: StudioApiPort; runtime: StudioRuntime; sample: boolean; onOpenChat: () => void }
const emptyKit: DisplayKit = { business: { name: '', facts: [] }, offers: [], audience: { pains: [], goals: [] }, voice: { use: [], avoid: [] },
  prohibitedClaims: [], colours: [], fonts: [], logoAssetIds: [], assetIds: [] };
const conflictNotice = 'Brand changed elsewhere. Copy your edits, then Refresh';

/** Preserve list edits as text until Save; O(b) time/space for the bounded kit. */
function editForm(required: { kit: DisplayKit }) {
  const kit = required.kit;
  return { businessName: kit.business.name, businessFacts: kit.business.facts.join('\n'),
    offers: kit.offers.map(offer => ({ name: offer.name, facts: offer.facts.join('\n') })),
    audiencePains: kit.audience.pains.join('\n'), audienceGoals: kit.audience.goals.join('\n'),
    voiceUse: kit.voice.use.join('\n'), voiceAvoid: kit.voice.avoid.join('\n'), prohibitedClaims: kit.prohibitedClaims.join('\n') };
}
type BrandForm = ReturnType<typeof editForm>;
type TextField = Exclude<keyof BrandForm, 'offers'>;
const textFields: { field: TextField; label: string }[] = [
  { field: 'businessFacts', label: 'Business facts' }, { field: 'audiencePains', label: 'Audience pains' }, { field: 'audienceGoals', label: 'Audience goals' },
  { field: 'voiceUse', label: 'Voice: use' }, { field: 'voiceAvoid', label: 'Voice: avoid' }, { field: 'prohibitedClaims', label: 'Prohibited claims' },
];
/** Newlines separate facts; blank lines carry no fact. Server schemas enforce all domain bounds. */
function lines(required: { text: string }): string[] { return required.text.split('\n').map(line => line.trim()).filter(Boolean); }
/** Text edits replace only editable fields, retaining opaque server data. O(b) time/space. */
function editedKit(required: { form: BrandForm; original: DisplayKit }): DisplayKit {
  const form = required.form;
  return { ...required.original, business: { name: form.businessName, facts: lines({ text: form.businessFacts }) },
    offers: form.offers.map(offer => ({ name: offer.name, facts: lines({ text: offer.facts }) })),
    audience: { pains: lines({ text: form.audiencePains }), goals: lines({ text: form.audienceGoals }) },
    voice: { use: lines({ text: form.voiceUse }), avoid: lines({ text: form.voiceAvoid }) }, prohibitedClaims: lines({ text: form.prohibitedClaims }) };
}

/** One retained operation, explicit Refresh, no polling or write retries. Typed text survives conflicts.
 * Success requires a completed operation read followed by both current profile reads.
 * @example useBrandProfile({ api, runtime, sample: false, onOpenChat });
 * @complexity O(b) form work for a server-bounded kit; constant requests per action, HTTP adapter deadlines.
 */
export function useBrandProfile(required: BrandProfileProps) {
  const [latest, setLatest] = useState<DisplayRevision | null>(null);
  const [confirmed, setConfirmed] = useState<DisplayRevision | null>(null);
  const [form, setForm] = useState(() => editForm({ kit: emptyKit }));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [card, setCard] = useState<ConfirmationCard | null>(null);
  const operation = useRef<{ id: string; kind: 'save' | 'confirm'; cardId?: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  /** Read through the shared tool API; a non-completed or malformed read never becomes an empty kit. */
  const read = async (input: { name: string }): Promise<DisplayRevision | null> => {
    const result = await required.api.tool?.({ call: { name: input.name, input: {}, operationId: required.runtime.ids.next({}) }, signal: controller.current?.signal });
    if (!result?.ok || result.value.status !== 'completed') throw new Error('Brand read unavailable');
    return revisionDisplaySchema.nullable().parse(result.value.output);
  };
  /** Apply both reads together; a conflict read updates evidence without discarding the editor. */
  const load = async (input: { replaceForm: boolean }): Promise<boolean> => {
    const [next, approved] = await Promise.all([read({ name: 'om_brand_get' }), read({ name: 'om_brand_confirmed' })]);
    if (controller.current?.signal.aborted) return false;
    setLatest(next); setConfirmed(approved); setLoaded(true);
    if (input.replaceForm) { setForm(editForm({ kit: next?.kit ?? emptyKit })); setConflict(false); }
    return true;
  };
  const markConflict = (): void => { operation.current = null; setPending(false); setCard(null); setConflict(true); setNotice(conflictNotice); };
  /** Recover only the current operation's card. A failed read retains its identity for Refresh. */
  const readCard = async (input: { id: string; cardId: string }): Promise<void> => {
    const found = await required.api.approvalCard?.({ cardId: input.cardId, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!found?.ok || found.value.operationId !== input.id || found.value.cardId !== input.cardId) { setError('Approval unavailable. Refresh to check again.'); return; }
    setCard(found.value); setNotice('Review the request, then Refresh to check the result.');
  };
  /** Only operation completion permits success. Unknown errors retain the operation; conflict preserves edits. */
  const reconcile = async (): Promise<'save' | 'confirm' | null> => {
    const active = operation.current;
    if (!active) return null;
    const result = await required.api.operation?.({ operationId: active.id, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return null;
    if (!result?.ok || result.value.operationId !== active.id) { setError('Operation unavailable. Refresh before another submission.'); return null; }
    const value = result.value;
    switch (value.status) {
      case 'completed': return active.kind;
      case 'pending': {
        const cardId = value.cardId ?? active.cardId;
        if (cardId) await readCard({ id: active.id, cardId });
        return null;
      }
      case 'unknown':
        setCard(null);
        if (value.error.code === 'conflict') markConflict();
        else setError('Outcome unresolved. Refresh before another submission.');
        return null;
      default:
        operation.current = null; setPending(false); setCard(null); setNotice('Operation ' + value.status + '. Review before submitting again.');
        return null;
    }
  };
  /** Refresh always reloads both reads; unresolved or conflicting operations keep the typed form. */
  const refreshData = async (): Promise<void> => {
    const active = operation.current;
    const completed = await reconcile();
    const refreshed = await load({ replaceForm: completed !== null || active === null });
    if (!completed || !refreshed) return;
    operation.current = null; setPending(false); setCard(null); setNotice(completed === 'save' ? 'Saved' : 'Confirmed');
  };
  /** Serialize actions and suppress replies after teardown using the injected abort seam. */
  const perform = async (input: { work: () => Promise<unknown> }): Promise<void> => {
    if (lock.current || controller.current?.signal.aborted) return;
    const signal = controller.current?.signal;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await input.work(); }
    catch { if (!signal?.aborted) setError('Brand response unavailable. Refresh before another submission.'); }
    finally { if (!signal?.aborted) { lock.current = false; setBusy(false); } }
  };
  /** Dispatch once with a new identity, then read that operation even if dispatch returned completed. */
  const write = async (input: { kind: 'save' | 'confirm'; name: string; input: ToolCall['input'] }): Promise<void> => {
    if (!loaded || operation.current || conflict) return;
    const id = required.runtime.ids.next({}); operation.current = { id, kind: input.kind }; setPending(true); setCard(null);
    const result = await required.api.tool?.({ call: { name: input.name, input: input.input, operationId: id }, signal: controller.current?.signal });
    if (controller.current?.signal.aborted) return;
    if (!result?.ok) {
      switch (result?.error.code) {
        case 'conflict': markConflict(); break;
        case 'invalid_input': operation.current = null; setPending(false); setError('Brand request rejected. Check the fields, then Refresh.'); break;
        default: setError('Brand outcome unavailable. Refresh before another submission.');
      }
      return;
    }
    if (result.value.status === 'pending') operation.current = { id, kind: input.kind, cardId: result.value.cardId };
    await refreshData();
  };
  useEffect(() => {
    const active = required.runtime.abort(); controller.current = active; lock.current = false;
    if (!required.sample) void perform({ work: () => load({ replaceForm: true }) });
    return () => active.abort();
  }, [required.api, required.runtime, required.sample]);
  /** Narrow native input ABI; handlers live outside TSX component bodies. */
  const changeText = (input: { field: TextField }) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const text = event.currentTarget.value; setForm(current => ({ ...current, [input.field]: text }));
  };
  const changeOffer = (input: { index: number; field: 'name' | 'facts' }) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const text = event.currentTarget.value; setForm(current => ({ ...current, offers: current.offers.map((offer, index) => index === input.index ? { ...offer, [input.field]: text } : offer) }));
  };
  const removeOffer = (input: { index: number }) => (): void => { setForm(current => ({ ...current, offers: current.offers.filter((_, index) => index !== input.index) })); };
  const addOffer = (): void => { setForm(current => current.offers.length >= 20 ? current : { ...current, offers: [...current.offers, { name: '', facts: '' }] }); };
  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void perform({ work: () => write({ kind: 'save', name: 'om_brand_save_draft', input: { kit: editedKit({ form, original: latest?.kit ?? emptyKit }), expectedRevision: latest?.revision ?? 0 } }) });
  };
  const confirm = (): void => {
    if (latest?.status !== 'draft') return;
    void perform({ work: () => write({ kind: 'confirm', name: 'om_brand_confirm', input: { revision: latest.revision } }) });
  };
  const refresh = (): void => { void perform({ work: refreshData }); };
  return { latest, confirmed, busy, pending, notice, error, card, save, confirm, refresh, addOffer,
    disabled: busy || pending || conflict || !loaded || !required.api.operation,
    businessName: { value: form.businessName, onChange: changeText({ field: 'businessName' }) },
    fields: textFields.map(item => ({ ...item, value: form[item.field], onChange: changeText(item) })),
    offers: form.offers.map((offer, index) => ({ ...offer, index, onNameChange: changeOffer({ index, field: 'name' }), onFactsChange: changeOffer({ index, field: 'facts' }), remove: removeOffer({ index }) })),
    visualDetails: JSON.stringify({ colours: latest?.kit.colours ?? [], fonts: latest?.kit.fonts ?? [], logoAssetIds: latest?.kit.logoAssetIds ?? [], assetIds: latest?.kit.assetIds ?? [] }, null, 2) };
}

/** Offer controls bind through hook-prepared callbacks; no closures in the TSX row. */
export type BrandOfferProps = ReturnType<typeof useBrandProfile>['offers'][number];
/** Textarea props are derived from the same editor state. */
export type BrandFieldProps = ReturnType<typeof useBrandProfile>['fields'][number];
