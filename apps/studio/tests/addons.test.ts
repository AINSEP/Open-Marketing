/** @vitest-environment jsdom */
/** Written-only D3 contracts: sample/HTTP share lifecycle assertions; no live egress. */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createHttpStudioApi, createSampleStudioApi, parseStudioSnapshot } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { PluginsPage, IntegrationsPage } from '../src/pages/addons/index.js';
import { packageUpload } from '../src/pages/addons/model/packages.hooks.js';
import { testRuntime } from './support/runtime.js';
import { testStudio } from './support/studio.js';
import { Shell } from '../src/app/shell/Shell.js';
import { createNavigationController } from '../src/features/navigate/index.js';
import { browserRoutes } from '../src/composition/adapters/browser.js';

const upload = { kind: 'plugin' as const, upload: { kind: 'files' as const, files: [{ path: 'jini.plugin.json', base64: 'e30=' }] } };
afterEach(cleanup);
/** The HTTP double delegates to the concrete fixture, exercising both owning boundaries. */
function transport(required: { api: NonNullable<StudioApiPort['addons']>; calls: { path: string; init?: RequestInit }[] }): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    required.calls.push({ path: url.pathname, init });
    const query = { limit: Number(url.searchParams.get('limit') ?? 25), cursor: url.searchParams.get('cursor') ?? undefined };
    const request = init?.body ? JSON.parse(String(init.body)) : undefined;
    let outcome;
    switch (url.pathname) {
      case '/api/addons/v1/packages': outcome = await required.api.list({ query: { ...query, kind: (url.searchParams.get('kind') ?? undefined) as 'plugin' | undefined } }); break;
      case '/api/addons/v1/install': outcome = await required.api.install({ request }); break;
      case '/api/addons/v1/set-enabled': outcome = await required.api.setEnabled({ request }); break;
      case '/api/addons/v1/uninstall': outcome = await required.api.uninstall({ request }); break;
      case '/api/addons/v1/integrations': outcome = await required.api.integrations({ query }); break;
      case '/api/addons/v1/integrations/token': outcome = await required.api.connect({ request }); break;
      case '/api/addons/v1/integrations/disconnect': outcome = await required.api.disconnect({ request }); break;
      default: throw new Error('Unexpected fixture route');
    }
    return Response.json(outcome, { status: outcome.ok ? 200 : 400 });
  };
}
for (const adapter of ['sample', 'http'] as const) {
  describe(adapter + ' add-ons API', () => {
    it('installs disabled, filters kind, toggles, and removes with stale actions rejected', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls: [] }) });
      const installed = await api.addons!.install({ request: upload });
      expect(installed).toMatchObject({ ok: true, value: { kind: 'plugin', enabled: false } });
      if (!installed.ok) throw new Error('Missing fixture package');
      const id = installed.value.id;
      expect(await api.addons!.list({ query: { kind: 'skill', limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
      expect(await api.addons!.setEnabled({ request: { kind: 'plugin', id, enabled: true } })).toMatchObject({ ok: true, value: { enabled: true } });
      expect(await api.addons!.setEnabled({ request: { kind: 'plugin', id, enabled: false } })).toMatchObject({ ok: true, value: { enabled: false } });
      expect(await api.addons!.uninstall({ request: { kind: 'plugin', id } })).toEqual({ ok: true, value: { kind: 'plugin', id, removed: true } });
      expect((await api.addons!.setEnabled({ request: { kind: 'plugin', id, enabled: true } })).ok).toBe(false);
      expect(host.pending()).toBe(0);
    });
    it('saves secret-free connections, rejects duplicate identity, paginates, disconnects', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
      const calls: { path: string; init?: RequestInit }[] = [];
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls }) });
      const request = { connectionId: 'key-one', pluginId: 'anthropic', plaintext: 'fixture-private-value' };
      const saved = await api.addons!.connect({ request });
      expect(saved).toEqual({ ok: true, value: { connectionId: 'key-one', pluginId: 'anthropic', status: 'saved' } });
      expect(await api.addons!.connect({ request })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      await api.addons!.connect({ request: { ...request, connectionId: 'key-two' } });
      const page = await api.addons!.integrations({ query: { limit: 1 } });
      expect(page).toMatchObject({ ok: true, value: { items: [{ connectionId: 'key-one' }], cursor: '1' } });
      if (!page.ok || !page.value.cursor) throw new Error('Missing cursor');
      expect(await api.addons!.integrations({ query: { limit: 1, cursor: page.value.cursor } })).toMatchObject({ ok: true, value: { items: [{ connectionId: 'key-two' }], cursor: null } });
      const disconnected = await api.addons!.disconnect({ request: { connectionId: 'key-one' } });
      expect(disconnected).toMatchObject({ ok: true, value: { status: 'disconnected' } });
      expect(JSON.stringify([saved, page, disconnected])).not.toContain(request.plaintext);
      if (adapter === 'http') expect(calls[0].init).toMatchObject({ credentials: 'same-origin', redirect: 'manual' });
    });
  });
}
it('rejects malformed wire values and never retries a failed write', async () => {
  const host = testRuntime(); let calls = 0;
  const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async () => { calls++; return Response.json({ ok: true, value: { plaintext: 'tainted' } }); } });
  expect((await api.addons!.connect({ request: { pluginId: 'anthropic', connectionId: 'one', plaintext: 'fixture' } })).ok).toBe(false);
  expect(calls).toBe(1); expect(host.pending()).toBe(0);
});
it('bounds aggregate file size before reading any file and preserves relative/binary bytes', async () => {
  let reads = 0;
  const file = ({ size, path }: { size: number; path: string }): File => ({ size, name: path, webkitRelativePath: path, async arrayBuffer() { reads++; return Uint8Array.from([0, 255, 1]).buffer; } }) as File;
  expect((await packageUpload({ kind: 'plugin', files: [file({ size: 20000000, path: 'a' }), file({ size: 20000000, path: 'b' })] })).ok).toBe(false);
  expect(reads).toBe(0);
  const result = await packageUpload({ kind: 'plugin', files: [file({ size: 3, path: 'root/jini.plugin.json' })] });
  expect(result).toEqual({ ok: true, value: { kind: 'plugin', upload: { kind: 'files', files: [{ path: 'root/jini.plugin.json', base64: 'AP8B' }] } } });
});
it('package controls call the same install/enable/disable/uninstall API', async () => {
  const host = testRuntime(); const api = createSampleStudioApi({ runtime: host.runtime });
  await api.addons!.install({ request: upload });
  render(createElement(PluginsPage, { api, runtime: host.runtime }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Disable' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enable' })).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  await waitFor(() => expect(screen.getByText('No add-ons installed here yet.')).toBeDefined());
});
it('clears the token before a failed response and redacts tainted errors from the form', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<StudioApiPort['addons']>['connect']>>>();
  const requests: unknown[] = [];
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!, connect: input => { requests.push(input.request); return pending.promise; } } };
  render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save token' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'fixture-secret-never-in-chat' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
  await waitFor(() => expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe(''));
  expect(requests).toHaveLength(1);
  await act(async () => { pending.resolve({ ok: false, error: { code: 'unavailable', message: 'fixture-secret-never-in-chat', retryable: false } }); });
  expect(screen.getByRole('alert').textContent).not.toContain('fixture-secret');
  expect(screen.getAllByRole('option')).toHaveLength(7);
});

it.each([
  { route: '/addons/plugins', label: 'Plugins', kind: 'plugin' },
  { route: '/addons/agent-plugins', label: 'Agent Plugins', kind: 'agent-plugin' },
  { route: '/addons/skills', label: 'Skills', kind: 'skill' },
  { route: '/addons/integrations', label: 'Integrations', kind: null },
])('mounts $label from an ADD-ONS link and restores the hash route', async ({ route, label, kind }) => {
  const host = testStudio();
  window.location.hash = '/addons/plugins';
  const navigation = createNavigationController({ browser: browserRoutes({ host: window }), timers: host.timer.runtime.timers, timeoutMs: 5000 });
  try {
    const view = render(createElement(Shell, { ...host.props, navigation }));
    const group = screen.getByRole('group', { name: 'ADD-ONS' });
    expect(group.querySelectorAll('a')).toHaveLength(4);
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe('#' + route);
    fireEvent.click(link);
    await waitFor(() => expect(navigation.getSnapshot()).toBe(route));
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeDefined();
    expect(link.getAttribute('aria-current')).toBe('page');
    if (kind) expect(view.container.querySelector('[data-action="addons_install"]')?.getAttribute('data-addon-kind')).toBe(kind);
    else expect(screen.getByRole('button', { name: 'Save token' })).toBeDefined();
    const restored = createNavigationController({ browser: browserRoutes({ host: window }), timers: host.timer.runtime.timers, timeoutMs: 5000 });
    expect(restored.getSnapshot()).toBe(route); restored.dispose();
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
  } finally { navigation.dispose(); host.dispose(); window.location.hash = ''; }
});

it('accepts optional add-on snapshot rows while rejecting missing legacy or unknown rows', async () => {
  const host = testRuntime(); const api = createSampleStudioApi({ runtime: host.runtime });
  const result = await api.snapshot({});
  if (!result.ok) throw new Error('Legacy fixture snapshot must remain valid');
  const rows = { ...result.value.rows, '/addons/plugins': [], '/addons/agent-plugins': [], '/addons/skills': [], '/addons/integrations': [] };
  expect(parseStudioSnapshot({ input: { ...result.value, rows } }).ok).toBe(true);
  expect(parseStudioSnapshot({ input: { ...result.value, rows: { ...rows, '/addons/unknown': [] } } }).ok).toBe(false);
  const { campaigns: _, ...missing } = rows as Record<string, unknown>;
  expect(parseStudioSnapshot({ input: { ...result.value, rows: missing } }).ok).toBe(false);
  expect(parseStudioSnapshot({ input: { ...result.value, rows: { ...rows, '/addons/plugins': [{ id: 'malformed' }] } } }).ok).toBe(false);
});
