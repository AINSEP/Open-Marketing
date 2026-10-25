import { useEffect, useState } from 'react';
import { recentEventsSchema } from '@open-marketing/contracts';
import type { CaptureEvent } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../shared/api/index.js';

/** One bounded snapshot and manual Refresh; cleanup ignores late data. No polling or retry. */
export function useEvents(required: { api: StudioApiPort; runtime: StudioRuntime }) {
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<CaptureEvent[]>([]);
  const [status, setStatus] = useState('Loading local events…');
  useEffect(() => {
    const controller = required.runtime.abort();
    const handle = required.runtime.timers.schedule({ delayMs: 15000, callback: () => { controller.abort(); setStatus('Local events unavailable'); } });
    const load = async (): Promise<void> => {
      try {
        const result = await required.api.recentEvents?.({ signal: controller.signal });
        if (controller.signal.aborted) return;
        const parsed = result?.ok ? recentEventsSchema.safeParse(result.value) : undefined;
        setItems(parsed?.success ? parsed.data.items : []);
        setStatus(parsed?.success ? (parsed.data.items.length ? 'Latest local events · oldest first' : 'No local events yet') : 'Local events unavailable');
      } catch { if (!controller.signal.aborted) setStatus('Local events unavailable'); }
      finally { required.runtime.timers.cancel({ handle }); }
    };
    void load();
    return () => { controller.abort(); required.runtime.timers.cancel({ handle }); };
  }, [required.api, required.runtime, revision]);
  return { items, status, refresh: () => { setStatus('Loading local events…'); setRevision(value => value + 1); } };
}
/** Only schema-validated fixed fields reach the list; no error messages, payloads or stacks. */
export function eventFields(required: { event: CaptureEvent }): string {
  return Object.entries(required.event).filter(([key]) => !['kind', 'name', 'at'].includes(key)).map(([key, value]) => key + ': ' + value).join(' · ');
}
