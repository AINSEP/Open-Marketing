import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { z } from 'zod';
import { idSchema } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';
import { leadDisplaySchema, leadStageRequestSchema } from '../../../shared/api/validation.js';
import type { LeadDisplay } from '../../../shared/api/validation.js';

export type LeadsProps = { api: StudioApiPort; runtime: StudioRuntime };
const inboxSchema = z.strictObject({ items: z.array(leadDisplaySchema).max(50), cursor: idSchema.nullable() });

/** One first-page read; the existing HTTP adapter owns deadlines and bounded response reading.
 * Input/output schemas reject malformed tool data before it enters state. No polling or retries. */
async function readInbox(required: LeadsProps & { signal: AbortSignal }) {
  const result = await required.api.tool?.({ call: { name: 'om_leads_list', operationId: required.runtime.ids.next({}),
    input: { query: { page: { limit: 50 } } } }, signal: required.signal });
  if (!result?.ok || result.value.status !== 'completed') return null;
  const parsed = inboxSchema.safeParse(result.value.output);
  return parsed.success ? parsed.data.items : null;
}

/** Inbox state and owner changes, with one active action and cancellation on unmount.
 * Conflicts reread; failed writes are never repeated. O(n) state updates, n <=50.
 * @example useLeads({ api, runtime }) */
export function useLeads(required: LeadsProps) {
  const { api, runtime } = required;
  const [items, setItems] = useState<LeadDisplay[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = runtime.abort();
    active.current = controller;
    setBusy(true);
    void load({ signal: controller.signal });
    return () => { controller.abort(); active.current = null; };
  }, [api, runtime]);

  /** Read failure stays visible; a cancelled or obsolete mount never updates state. */
  async function load(input: { signal: AbortSignal }) {
    try {
      const leads = await readInbox({ api, runtime, ...input });
      if (input.signal.aborted) return false;
      if (leads === null) { setError('Lead inbox unavailable.'); return false; }
      setItems(leads);
      return true;
    } catch { if (!input.signal.aborted) setError('Lead inbox unavailable.'); return false; }
    finally { if (!input.signal.aborted) setBusy(false); }
  }

  /** Compare-and-set the displayed revision once; a conflict reloads authoritative rows. */
  async function change(input: { lead: LeadDisplay; to: string }) {
    const controller = active.current;
    if (busy || !controller || controller.signal.aborted) return;
    const request = leadStageRequestSchema.safeParse({ leadId: input.lead.leadId, to: input.to,
      expectedRevision: input.lead.revision, changeId: runtime.ids.next({}) });
    if (!request.success) return;
    setBusy(true); setError('');
    const result = await api.setLeadStage?.({ request: request.data, signal: controller.signal }).catch(() => null);
    if (controller.signal.aborted) return;
    setBusy(false);
    if (result?.ok) { setItems(current => current.map(lead => lead.leadId === result.value.leadId ? result.value : lead)); return; }
    if (result && result.error.code === 'conflict') {
      setBusy(true);
      const refreshed = await load({ signal: controller.signal });
      if (refreshed) setError('This lead changed. The inbox has been refreshed.');
      return;
    }
    setError('Could not change the lead stage. Refresh before trying again.');
  }
  const rows = items.map(lead => ({ lead, disabled: busy || lead.erased,
    onChange: (event: ChangeEvent<HTMLSelectElement>) => { void change({ lead, to: event.target.value }); } }));
  return { rows, busy, error };
}
export type LeadRowProps = ReturnType<typeof useLeads>['rows'][number];
