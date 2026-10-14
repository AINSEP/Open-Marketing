/** Package page state and native upload boundary; components contain markup only. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { installAddonSchema } from '@open-marketing/contracts';
import type { AddonKind, AddonSummary, InstallAddon, Outcome } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

export interface PackagePageProps { api: StudioApiPort; runtime: StudioRuntime; kind: AddonKind }
export interface PackageRowProps { addon: AddonSummary; busy: boolean; setEnabled(required: { addon: AddonSummary }): Promise<void>; uninstall(required: { addon: AddonSummary }): Promise<void> }

/** Read native files only after count/aggregate bounds; the server owns format/root validation.
 * @example await packageUpload({ files: [...input.files], kind: 'plugin' });
 * @complexity O(b + f), b<=32 MiB, f<=4096; sequential reads avoid parallel copies of the upload.
 */
export async function packageUpload(required: { files: readonly File[]; kind: AddonKind }): Promise<Outcome<InstallAddon>> {
  if (!required.files.length || required.files.length > 4096 || required.files.reduce((total, file) => total + file.size, 0) > 33554432) return uploadFailure();
  try {
    const first = required.files[0];
    if (required.files.length === 1 && !first.webkitRelativePath && /\.zip$/i.test(first.name)) {
      const upload = { kind: 'zip' as const, base64: base64({ bytes: new Uint8Array(await first.arrayBuffer()) }) };
      const parsed = installAddonSchema.safeParse({ kind: required.kind, upload });
      return parsed.success ? { ok: true, value: parsed.data } : uploadFailure();
    }
    const files = [];
    for (const file of required.files) files.push({ path: file.webkitRelativePath || file.name, base64: base64({ bytes: new Uint8Array(await file.arrayBuffer()) }) });
    const parsed = installAddonSchema.safeParse({ kind: required.kind, upload: { kind: 'files', files } });
    return parsed.success ? { ok: true, value: parsed.data } : uploadFailure();
  } catch { return uploadFailure(); }
}
/** Chunked native encoding avoids spreading a large upload into the JS argument stack. */
function base64(required: { bytes: Uint8Array }): string {
  const chunks = [];
  for (let offset = 0; offset < required.bytes.length; offset += 8192) chunks.push(String.fromCharCode(...required.bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join(''));
}
function uploadFailure(): Outcome<never> { return { ok: false, error: { code: 'invalid_input', message: 'Choose a folder or ZIP up to 32 MiB and 4096 files.', retryable: false } }; }

/** List one kind, install disabled, refresh after writes, and ignore detached read responses.
 * Writes are never retried; errors direct the owner to refresh before resubmitting.
 * @example usePackages({ api, runtime, kind: 'skill' });
 * @complexity <=100 rows/page; one upload plus one refresh per owner mutation.
 */
export function usePackages(required: PackagePageProps) {
  const [items, setItems] = useState<AddonSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const readEpoch = useRef(0);
  const lock = useRef(false);
  const load = async (input: { cursor?: string; signal?: AbortSignal } = {}): Promise<void> => {
    const epoch = ++readEpoch.current;
    setLoading(true);
    try {
      if (!required.api.addons) { setError('Add-ons are unavailable on this server.'); return; }
      const result = await required.api.addons.list({ query: { kind: required.kind, limit: 100, cursor: input.cursor }, signal: input.signal });
      if (!mounted.current || input.signal?.aborted || epoch !== readEpoch.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setItems(result.value.items); setCursor(result.value.cursor);
    } catch { if (mounted.current) setError('Add-ons could not be loaded.'); }
    finally { if (mounted.current && epoch === readEpoch.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = required.runtime.abort();
    void load({ signal: controller.signal });
    return () => { mounted.current = false; readEpoch.current++; controller.abort(); };
  }, [required.api, required.kind, required.runtime]);
  const mutate = async (input: { run: () => Promise<Outcome<unknown>>; message: string }): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await input.run();
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setNotice(input.message); await load();
    } catch { if (mounted.current) setError('Response unavailable. Refresh before another submission.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    await mutate({ message: 'Installed disabled. Enable when you want to use it.', run: async () => {
      const request = await packageUpload({ files, kind: required.kind });
      if (!request.ok) return request;
      return required.api.addons ? required.api.addons.install({ request: request.value }) : uploadFailure();
    } });
  };
  const setEnabled = (input: { addon: AddonSummary }): Promise<void> => mutate({ message: input.addon.enabled ? 'Disabled.' : 'Enabled.', run: () => required.api.addons!.setEnabled({ request: { kind: required.kind, id: input.addon.id, enabled: !input.addon.enabled } }) });
  const uninstall = (input: { addon: AddonSummary }): Promise<void> => mutate({ message: 'Uninstalled.', run: () => required.api.addons!.uninstall({ request: { kind: required.kind, id: input.addon.id } }) });
  const refresh = (): void => { setError(''); void load(); };
  const next = (): void => { if (cursor) void load({ cursor }); };
  return { items, busy: busy || loading, error, notice, upload, setEnabled, uninstall, refresh, next, cursor, rows: items.map(addon => ({ addon, busy: busy || loading, setEnabled, uninstall })), folderAttributes: { webkitdirectory: '', directory: '' } };
}
/** React/native click wrappers bind one row, never define callbacks inside TSX. */
export function usePackageRow(required: PackageRowProps) {
  return { toggle: () => { void required.setEnabled({ addon: required.addon }); }, remove: () => { void required.uninstall({ addon: required.addon }); } };
}
