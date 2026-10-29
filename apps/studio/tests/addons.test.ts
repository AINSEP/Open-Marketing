/** @vitest-environment jsdom */
/** Written-only D3 contracts: sample/HTTP share lifecycle assertions; no live egress. */
import { afterEach, describe, expect, it } from 'vitest';
import { credentialCardSchema } from '@open-marketing/contracts';
import { sampleCredentialCards, sampleMailCandidates } from '../src/shared/api/sample-data.js';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { createHttpStudioApi, createSampleStudioApi, parseStudioSnapshot, oauthChallengeSchema } from '../src/shared/api/index.js';
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
      case '/api/addons/v1/provider-settings/mail': outcome = init?.method === 'POST' ? await required.api.setMailProviderSettings({ request }) : await required.api.mailProviderSettings({}); break;
      case '/api/addons/v1/packages': outcome = await required.api.list({ query: { ...query, kind: (url.searchParams.get('kind') ?? undefined) as 'plugin' | undefined } }); break;
      case '/api/addons/v1/install': outcome = await required.api.install({ request }); break;
      case '/api/addons/v1/set-enabled': outcome = await required.api.setEnabled({ request }); break;
      case '/api/addons/v1/uninstall': outcome = await required.api.uninstall({ request }); break;
      case '/api/addons/v1/integrations/oauth/client': outcome = await required.api.setOAuthClient({ request }); break;
      case '/api/addons/v1/integrations/oauth/status': outcome = await required.api.oauthStatus({ query: url.searchParams.has('pluginId') ? { pluginId: url.searchParams.get('pluginId')! } : { transactionId: url.searchParams.get('transactionId')! } }); break;
      case '/api/addons/v1/integrations/conversion-settings': outcome = init?.method === 'POST' ? await required.api.setConversionSettings({ request }) : await required.api.conversionSettings({ pluginId: url.searchParams.get('pluginId')! }); break;
      case '/api/addons/v1/integrations/plugin-secret': outcome = init?.method === 'POST' ? await required.api.setPluginSecret({ request }) : await required.api.pluginSecretStatus({ pluginId: url.searchParams.get('pluginId')! }); break;
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
    it('sets and clears the From override, preserves omissions and refuses invalid input before requests', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime }); const calls: { path: string; init?: RequestInit }[] = [];
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls }) });
      const addons = api.addons!;
      expect(await addons.mailProviderSettings({})).toEqual({ ok: true, value: { selected: null, alertFrom: null, candidates: sampleMailCandidates } });
      const selection = { selected: 'sample-mail-relay', alertFrom: 'owner-from@example.test' };
      expect(await addons.setMailProviderSettings({ request: selection })).toEqual({ ok: true, value: selection });
      expect(await addons.mailProviderSettings({})).toMatchObject({ ok: true, value: selection });
      expect(await addons.setMailProviderSettings({ request: { selected: 'not-a-candidate', alertFrom: 'refused@example.test' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await addons.mailProviderSettings({})).toMatchObject({ ok: true, value: selection });
      expect(await addons.setMailProviderSettings({ request: { selected: null } })).toEqual({ ok: true, value: { selected: null } });
      expect(await addons.mailProviderSettings({})).toMatchObject({ ok: true, value: { selected: null, alertFrom: selection.alertFrom } });
      expect(await addons.setMailProviderSettings({ request: { selected: null, alertFrom: null } })).toEqual({ ok: true, value: { selected: null, alertFrom: null } });
      expect(await addons.mailProviderSettings({})).toMatchObject({ ok: true, value: { selected: null, alertFrom: null } });
      const before = calls.length;
      const invalid = await addons.setMailProviderSettings({ request: { selected: null, alertFrom: 'synthetic-secret-invalid-address' } });
      expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(JSON.stringify(invalid)).not.toContain('synthetic-secret');
      expect(calls).toHaveLength(before);
      if (adapter === 'http') expect(calls[1]).toMatchObject({ path: '/api/addons/v1/provider-settings/mail', init: { method: 'POST', body: JSON.stringify(selection) } });
      expect(host.pending()).toBe(0);
    });
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
    it('sets, reads, replaces and clears sealed client/plugin-secret configuration without returning secrets', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls: [] }) });
      const addons = api.addons!;
      expect(await addons.oauthStatus({ query: { pluginId: 'sample-oauth-service' } })).toMatchObject({ ok: true, value: { configured: false, credentialCards: sampleCredentialCards.filter(card => card.pluginId === 'sample-oauth-service'), connections: [], connectionsCursor: null } });
      const saved = await addons.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'client-one', clientSecret: 'private-client-fixture' } } });
      expect(saved).toEqual({ ok: true, value: { configured: true, clientId: 'client-one' } });
      expect(await addons.oauthStatus({ query: { pluginId: 'sample-oauth-service' } })).toMatchObject({ ok: true, value: { configured: true, clientId: 'client-one', credentialCards: expect.any(Array) } });
      expect(credentialCardSchema.array().parse(sampleCredentialCards)).toEqual(sampleCredentialCards);
      expect(await addons.oauthStatus({ query: { pluginId: 'fixture-plugin' } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'fixture', clientSecret: 'private-fixture', tenantId: 'tenant-123' } } })).toMatchObject({ ok: true });
      expect(await addons.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'client-two' } } })).toMatchObject({ ok: true, value: { clientId: 'client-two' } });
      expect(await addons.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: null } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.oauthStatus({ query: { pluginId: 'sample-oauth-service' } })).toMatchObject({ ok: true, value: { configured: false, credentialCards: sampleCredentialCards.filter(card => card.pluginId === 'sample-oauth-service'), connections: [], connectionsCursor: null } });
      expect(await addons.setPluginSecret({ request: { pluginId: 'sample-key-service', values: { serviceKey: 'private-plugin-fixture' } } })).toEqual({ ok: true, value: { configured: true } });
      expect(await addons.pluginSecretStatus({ pluginId: 'sample-key-service' })).toEqual({ ok: true, value: { configured: true } });
      expect(await addons.setPluginSecret({ request: { pluginId: 'sample-key-service', values: null } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.pluginSecretStatus({ pluginId: 'sample-key-service' })).toEqual({ ok: true, value: { configured: false } });
      expect(JSON.stringify(saved)).not.toContain('private-client-fixture');
      expect(await addons.integrations({ query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
      expect(host.pending()).toBe(0);
    });
    it('saves secret-free connections, rejects duplicate identity, paginates, disconnects', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
      const calls: { path: string; init?: RequestInit }[] = [];
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls }) });
      const request = { connectionId: 'key-one', pluginId: 'sample-key-service', plaintext: 'fixture-private-value' };
      const saved = await api.addons!.connect({ request });
      expect(saved).toEqual({ ok: true, value: { connectionId: 'key-one', pluginId: 'sample-key-service', status: 'saved' } });
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
it.each(['refused', 'thrown'] as const)('saves/clears the From address and restores confirmed values when %s', async mode => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const requests: unknown[] = []; let refuse = false; let reads = 0;
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!,
    mailProviderSettings(input) { reads++; return sample.addons!.mailProviderSettings(input); },
    async setMailProviderSettings(input) {
      requests.push(input.request);
      if (refuse && mode === 'thrown') throw new Error('synthetic-secret');
      if (refuse) return { ok: false, error: { code: 'invalid_input', message: 'synthetic-secret', retryable: false } };
      return sample.addons!.setMailProviderSettings(input);
    },
  } };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const select = screen.getByRole('combobox', { name: 'Mail provider' }) as HTMLSelectElement;
  const save = screen.getByRole('button', { name: 'Save mail provider' }) as HTMLButtonElement;
  const from = screen.getByRole('textbox', { name: 'From address' }) as HTMLInputElement;
  const useDefault = screen.getByRole('button', { name: 'Use plugin default' }) as HTMLButtonElement;
  expect(from.disabled).toBe(true); expect(useDefault.disabled).toBe(true);
  await waitFor(() => expect(save.disabled).toBe(false));
  expect(screen.getByRole('option', { name: 'Sample mail service (Connected)' })).toBeDefined();
  expect(screen.getByRole('option', { name: 'Sample mail relay (Not connected)' })).toBeDefined();
  expect(from.type).toBe('email'); expect(from.maxLength).toBe(254); expect(from.placeholder).toBe('Default from plugin');
  fireEvent.change(select, { target: { value: 'sample-mail-relay' } });
  fireEvent.change(from, { target: { value: 'owner-from@example.test' } }); fireEvent.click(save);
  await screen.findByText('Mail provider saved.');
  expect(requests).toEqual([{ selected: 'sample-mail-relay', alertFrom: 'owner-from@example.test' }]); expect(select.value).toBe('sample-mail-relay'); expect(from.value).toBe('owner-from@example.test'); expect(reads).toBe(1);
  refuse = true;
  fireEvent.change(select, { target: { value: 'sample-mail-service' } });
  fireEvent.change(from, { target: { value: 'refused@example.test' } }); fireEvent.click(save);
  await screen.findByText('Mail provider could not be confirmed. Refresh before resubmitting.');
  expect(requests).toEqual([{ selected: 'sample-mail-relay', alertFrom: 'owner-from@example.test' }, { selected: 'sample-mail-service', alertFrom: 'refused@example.test' }]);
  expect(select.value).toBe('sample-mail-relay'); expect(from.value).toBe('owner-from@example.test');
  expect(view.container.textContent).not.toContain('synthetic-secret');
  refuse = false; fireEvent.click(useDefault); expect(from.value).toBe(''); expect(requests).toHaveLength(2); fireEvent.click(save);
  await screen.findByText('Mail provider saved.');
  expect(requests[2]).toEqual({ selected: 'sample-mail-relay', alertFrom: null });
  expect(from.value).toBe(''); expect(reads).toBe(1);
  expect(within(screen.getByRole('region', { name: 'Mail provider' })).queryByText(/verified/i)).toBeNull();
  view.unmount(); expect(host.pending()).toBe(0);
});
it('blocks every-field-blank optional credential forms and omits plugins with no cards', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime }); let secrets = 0; let connections = 0;
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!,
    async list(input) {
      const result = await sample.addons!.list(input);
      if (!result.ok) return result;
      return { ok: true, value: { ...result.value, items: [...result.value.items, { ...result.value.items[0], id: 'sample-empty-service', name: 'Empty service' }] } };
    },
    async oauthStatus(input) {
      if ('pluginId' in input.query && input.query.pluginId === 'sample-key-service') return { ok: true, value: { configured: false, connections: [], connectionsCursor: null, credentialCards: [
        { ...sampleCredentialCards[2], saveKind: 'app-credentials', fields: [{ name: 'applicationId', label: 'Application ID', type: 'string' }], secretFields: [{ name: 'applicationSecret', label: 'Application secret' }] },
        { ...sampleCredentialCards[3], secretFields: [{ name: 'serviceKey', label: 'Service key' }] },
      ] } };
      return sample.addons!.oauthStatus(input);
    },
    setPluginSecret(input) { secrets++; return sample.addons!.setPluginSecret(input); },
    connect(input) { connections++; return sample.addons!.connect(input); },
  } };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save secret' }) as HTMLButtonElement).disabled).toBe(false));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save token' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('region', { name: 'Empty service integration' })).toBeNull();
  fireEvent.submit((screen.getByLabelText('Service key') as HTMLInputElement).form!);
  fireEvent.submit((screen.getByLabelText('Application ID') as HTMLInputElement).form!);
  await screen.findByText('Enter valid secret fields.'); await screen.findByText('Enter valid credentials and whole-number integer fields.');
  expect(secrets).toBe(0); expect(connections).toBe(0);
  view.unmount(); expect(host.pending()).toBe(0);
});
it('rejects malformed wire values and never retries a failed write', async () => {
  const host = testRuntime(); let calls = 0;
  const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async () => { calls++; return Response.json({ ok: true, value: { plaintext: 'tainted' } }); } });
  expect((await api.addons!.connect({ request: { pluginId: 'sample-key-service', connectionId: 'one', plaintext: 'fixture' } })).ok).toBe(false);
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
  const alerts = screen.getAllByRole('alert'); expect(alerts.length).toBeGreaterThan(0);
  for (const alert of alerts) expect(alert.textContent).not.toContain('fixture-secret');
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
    const group = screen.getByRole('region', { name: 'ADD-ONS' });
    expect(group.querySelectorAll('a')).toHaveLength(4);
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe('#' + route);
    fireEvent.click(link);
    await waitFor(() => expect(navigation.getSnapshot()).toBe(route));
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeDefined();
    expect(link.getAttribute('aria-current')).toBe('page');
    if (kind) expect(view.container.querySelector('[data-action="addons_install"]')?.getAttribute('data-addon-kind')).toBe(kind);
    else expect(await screen.findByRole('button', { name: 'Save token' })).toBeDefined();
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

it('renders declared OAuth extras and posts them while clearing private inputs before the response', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<StudioApiPort['addons']>['setOAuthClient']>>>();
  const requests: unknown[] = [];
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!, setOAuthClient: input => { requests.push(input.request); return pending.promise; } } };
  render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const service = within(await screen.findByRole('region', { name: 'Sample OAuth service integration' }));
  await waitFor(() => expect(service.getByText('Client configuration required')).toBeDefined());
  fireEvent.click(service.getByText('OAuth client configuration'));
  fireEvent.change(service.getByLabelText('Client ID'), { target: { value: 'fixture-client' } });
  fireEvent.change(service.getByLabelText('Client secret'), { target: { value: 'fixture-private-client' } });
  fireEvent.change(service.getByLabelText('Tenant ID'), { target: { value: 'tenant-fixture' } });
  expect(service.getByLabelText('Client secret').closest('[data-agent-private]')).toBeTruthy();
  fireEvent.click(service.getByRole('button', { name: 'Save client configuration' }));
  expect((service.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(requests).toEqual([{ pluginId: 'sample-oauth-service', client: { clientId: 'fixture-client', clientSecret: 'fixture-private-client', tenantId: 'tenant-fixture' } }]);
  await act(async () => pending.resolve({ ok: false, error: { code: 'unavailable', message: 'fixture-private-client', retryable: false } }));
  expect(service.getByRole('alert').textContent).not.toContain('fixture-private-client');
});
it('starts sign-in through one policy card and reads its operation before offering an expiring HTTPS link', async () => {
  const challenge = { transactionId: 'challenge', authorizationUrl: 'https://accounts.example.test/authorize', expiresAt: 8640000000000000 };
  expect(oauthChallengeSchema.safeParse(challenge).success).toBe(true);
  expect(oauthChallengeSchema.safeParse({ ...challenge, authorizationUrl: 'http://accounts.example.test/authorize' }).success).toBe(false);
  expect(oauthChallengeSchema.safeParse({ ...challenge, authorizationUrl: 'https://user@accounts.example.test/authorize' }).success).toBe(false);
  expect(oauthChallengeSchema.safeParse({ ...challenge, authorizationUrl: 'https://:secret@accounts.example.test/authorize' }).success).toBe(false);
  expect(oauthChallengeSchema.safeParse({ ...challenge, expiresAt: 8640000000000001 }).success).toBe(false);
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  await sample.addons!.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'fixture-client' } } });
  let operationId = ''; const names: string[] = []; let approved = false;
  const api: StudioApiPort = { ...sample,
    async tool(input) { if (input.call.name === 'om_message_connections' || input.call.name === 'om_measure_grants_list') return { ok: true, value: { status: 'completed', output: { items: [] } } }; names.push(input.call.name); operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async approvalCard() { return { ok: true, value: { cardId: 'oauth-card', operationId, argumentsDigest: 'a'.repeat(64), arguments: { tool: 'integrations_oauth_start', input: { pluginId: 'sample-oauth-service' } }, classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 } }; },
    async approve() { approved = true; return { ok: true, value: { status: 'recorded' } }; },
    async operation() { return approved ? { ok: true, value: { status: 'completed', operationId, output: { transactionId: 'transaction', authorizationUrl: 'https://accounts.example.test/authorize?state=fixture', expiresAt: 61000 } } } : { ok: true, value: { status: 'pending', operationId } }; },
  };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const service = within(await screen.findByRole('region', { name: 'Sample OAuth service integration' }));
  await waitFor(() => expect((service.getByRole('button', { name: 'Sign in with Sample OAuth service' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(service.getByRole('button', { name: 'Sign in with Sample OAuth service' }));
  await waitFor(() => expect(service.getByRole('article', { name: 'Review tool call' })).toBeDefined());
  expect(service.queryByRole('link', { name: 'Continue to Sample OAuth service' })).toBeNull();
  fireEvent.click(service.getByRole('button', { name: /^Allow$/ }));
  await waitFor(() => expect(approved).toBe(true));
  fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  await waitFor(() => expect(service.getByRole('link', { name: 'Continue to Sample OAuth service' }).getAttribute('href')).toContain('https://accounts.example.test/'));
  expect(names).toEqual(['integrations_oauth_start']);
  await act(async () => host.advance({ ms: 60000 }));
  expect(service.queryByRole('link', { name: 'Continue to Sample OAuth service' })).toBeNull();
  view.unmount(); expect(host.pending()).toBe(0);
});

/** An unknown start may already have reached the provider; status reads must keep the same identity. */
it.each(['cancelled', 'interrupted', 'completed'] as const)('blocks another OAuth start while unknown, until reconciled as %s', async terminal => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  await sample.addons!.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'fixture-client' } } });
  let operationId = ''; let starts = 0; let reconciled = false; const reads: string[] = [];
  const api: StudioApiPort = { ...sample,
    async tool(input) { if (input.call.name === 'om_message_connections' || input.call.name === 'om_measure_grants_list') return { ok: true, value: { status: 'completed', output: { items: [] } } }; starts++; operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async approvalCard() { return { ok: true, value: oauthCard({ operationId }) }; },
    async operation(input) {
      reads.push(input.operationId);
      if (!reconciled) return { ok: true, value: { status: 'unknown', operationId, error: { code: 'unavailable', message: 'Fixture outcome unknown', retryable: false } } };
      if (terminal === 'completed') return { ok: true, value: { status: 'completed', operationId, output: { transactionId: 'reconciled-transaction', authorizationUrl: 'https://accounts.example.test/reconciled', expiresAt: 1000000 } } };
      return { ok: true, value: { status: terminal, operationId } };
    },
  };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const service = within(await screen.findByRole('region', { name: 'Sample OAuth service integration' }));
  const signIn = await service.findByRole('button', { name: 'Sign in with Sample OAuth service' }) as HTMLButtonElement;
  await waitFor(() => expect(signIn.disabled).toBe(false));
  fireEvent.click(signIn);
  await waitFor(() => expect(service.getByRole('article', { name: 'Review tool call' })).toBeDefined());
  const originalId = operationId;
  fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  await waitFor(() => expect(service.getByText('Sign-in outcome unresolved. Check status again before starting another sign-in.')).toBeDefined());
  expect(service.queryByRole('article', { name: 'Review tool call' })).toBeNull();
  await act(async () => host.advance({ ms: 300001 }));
  expect(signIn.disabled).toBe(true); fireEvent.click(signIn); expect(starts).toBe(1);
  fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(reads).toEqual([originalId, originalId]); expect(signIn.disabled).toBe(true);
  reconciled = true;
  await waitFor(() => expect((service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  if (terminal === 'completed') {
    await waitFor(() => expect(service.getByRole('link', { name: 'Continue to Sample OAuth service' }).getAttribute('href')).toBe('https://accounts.example.test/reconciled'));
    expect(signIn.disabled).toBe(true);
  } else {
    await waitFor(() => expect(signIn.disabled).toBe(false));
  }
  expect(starts).toBe(1); expect(reads).toEqual([originalId, originalId, originalId]);
  view.unmount(); expect(host.pending()).toBe(0);
});

/** Pending receipt/card identity checks apply equally to the first load and recovery loads. */
it.each(['valid', 'wrong-operation', 'wrong-card'] as const)('recovers a failed OAuth approval read and rejects %s recovery evidence', async evidence => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  await sample.addons!.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { clientId: 'fixture-client' } } });
  let operationId = ''; let starts = 0; let repaired = false; const cards: string[] = []; const operations: string[] = [];
  const api: StudioApiPort = { ...sample,
    async tool(input) { if (input.call.name === 'om_message_connections' || input.call.name === 'om_measure_grants_list') return { ok: true, value: { status: 'completed', output: { items: [] } } }; starts++; operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async operation(input) { operations.push(input.operationId); return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async approvalCard(input) {
      cards.push(input.cardId);
      if (cards.length === 1) return { ok: false, error: { code: 'unavailable', message: 'Fixture read failed', retryable: true } };
      const card = oauthCard({ operationId });
      if (!repaired && evidence === 'wrong-operation') return { ok: true, value: { ...card, operationId: 'foreign-operation' } };
      if (!repaired && evidence === 'wrong-card') return { ok: true, value: { ...card, cardId: 'foreign-card' } };
      return { ok: true, value: card };
    },
  };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const service = within(await screen.findByRole('region', { name: 'Sample OAuth service integration' }));
  const signIn = await service.findByRole('button', { name: 'Sign in with Sample OAuth service' }) as HTMLButtonElement;
  await waitFor(() => expect(signIn.disabled).toBe(false)); fireEvent.click(signIn);
  await waitFor(() => expect(service.getByRole('alert').textContent).toContain('Sign-in approval unavailable.'));
  expect(signIn.disabled).toBe(true); expect(service.queryByRole('button', { name: /^Allow$/ })).toBeNull();
  fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  if (evidence !== 'valid') {
    await waitFor(() => expect(service.getByRole('alert').textContent).toBe('Sign-in approval identity mismatch.'));
    expect(service.queryByRole('button', { name: /^Allow$/ })).toBeNull(); expect(signIn.disabled).toBe(true);
    repaired = true; fireEvent.click(service.getByRole('button', { name: 'Check Sample OAuth service sign-in status' }));
  }
  await waitFor(() => expect(service.getByRole('button', { name: /^Allow$/ })).toBeDefined());
  expect(starts).toBe(1); expect(cards).toEqual(Array(evidence === 'valid' ? 2 : 3).fill('oauth-card'));
  expect(operations).toEqual(Array(evidence === 'valid' ? 1 : 2).fill(operationId));
  view.unmount(); expect(host.pending()).toBe(0);
});

function oauthCard(required: { operationId: string }): import('@open-marketing/contracts').ConfirmationCard {
  return { cardId: 'oauth-card', operationId: required.operationId, argumentsDigest: 'a'.repeat(64), arguments: { tool: 'integrations_oauth_start', input: { pluginId: 'sample-oauth-service' } }, classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 };
}

it('shows boolean plugin-secret status and clears private inputs before the save resolves', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<StudioApiPort['addons']>['setPluginSecret']>>>();
  let request: Parameters<NonNullable<StudioApiPort['addons']>['setPluginSecret']>[0]['request'] | undefined;
  let reads = 0; let saves = 0;
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!,
    async pluginSecretStatus(input) { if (++reads === 1) return { ok: false, error: { code: 'unavailable', message: 'Fixture unavailable', retryable: false } }; return sample.addons!.pluginSecretStatus(input); },
    setPluginSecret(input) { request = input.request; if (++saves === 1) return pending.promise; if (saves === 2) throw new Error('Fixture save failed'); return sample.addons!.setPluginSecret(input); },
  } };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const service = within(await screen.findByRole('region', { name: 'Sample key service integration' }));
  await waitFor(() => expect(reads).toBe(1)); expect(service.getByText('Status unavailable')).toBeDefined();
  await waitFor(() => expect((service.getByRole('button', { name: 'Refresh secret status' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(service.getByRole('button', { name: 'Refresh secret status' }));
  await service.findByText('Secret not configured');
  const secret = service.getByLabelText('Service key') as HTMLInputElement;
  fireEvent.change(secret, { target: { value: 'fixture-plugin-secret-sentinel' } });
  expect(secret.type).toBe('password'); expect(secret.dataset.private).toBe('true'); expect(secret.dataset.agentPrivate).toBe('true');
  expect(secret.form?.dataset.private).toBe('true'); expect(secret.form?.dataset.agentPrivate).toBe('true');
  fireEvent.click(service.getByRole('button', { name: 'Save secret' }));
  expect(secret.value).toBe('');
  expect(request).toEqual({ pluginId: 'sample-key-service', values: { serviceKey: 'fixture-plugin-secret-sentinel' } });
  await act(async () => { pending.resolve(await sample.addons!.setPluginSecret({ request: request! })); });
  await service.findByText('Secret configured');
  expect(await sample.addons!.pluginSecretStatus({ pluginId: 'sample-key-service' })).toEqual({ ok: true, value: { configured: true } });
  expect(view.container.innerHTML).not.toContain('fixture-plugin-secret-sentinel');
  expect(view.container.textContent).not.toContain('fixture-plugin-secret-sentinel');
  expect(screen.queryByText('Connection verified')).toBeNull();
  fireEvent.change(secret, { target: { value: 'fixture-failed-secret' } });
  fireEvent.click(service.getByRole('button', { name: 'Save secret' }));
  expect(secret.value).toBe('');
  await service.findByText('Save unconfirmed. Refresh before resubmitting.');
  fireEvent.click(service.getByRole('button', { name: 'Clear secret' }));
  await service.findByText('Secret not configured');
});
it('rejects malformed owner configuration before HTTP and rejects tainted status replies', async () => {
  const host = testRuntime(); let calls = 0;
  const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async () => { calls++; return Response.json({ ok: true, value: { configured: true, clientId: 'fixture', clientSecret: 'must-not-arrive' } }); } });
  expect((await api.addons!.setOAuthClient({ request: { pluginId: 'sample-oauth-service', client: { tenantId: 'fixture' } } as never })).ok).toBe(false);
  expect(calls).toBe(0);
  expect((await api.addons!.oauthStatus({ query: { pluginId: 'sample-oauth-service' } })).ok).toBe(false);
  expect(calls).toBe(1);
});


it.each(['sample', 'http'] as const)('%s conversion settings read is empty in sample mode and writes are unavailable', async adapter => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const calls: { path: string; init?: RequestInit }[] = [];
  const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls }) });
  expect(await api.addons!.conversionSettings({ pluginId: 'fixture' })).toEqual({ ok: true, value: { pluginId: 'fixture', declaration: null, values: null } });
  expect(await api.addons!.setConversionSettings({ request: { pluginId: 'fixture', values: {} } })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  expect(host.pending()).toBe(0);
});

it('loads non-secret declared conversion fields and parses textarea mappings as exact string values on save', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime }); const requests: unknown[] = [];
  const pluginId = 'sample-key-service';
  const declaration = { fields: [{ name: 'targets', label: 'Definition targets', hint: 'One key=value per line', kind: 'string-map' as const, format: 'decimal-id' as const },
    { name: 'code', label: 'Source code', kind: 'string' as const, format: 'code' as const }] };
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!,
    async conversionSettings(input) { return { ok: true, value: { pluginId: input.pluginId, declaration: input.pluginId === pluginId ? declaration : null, values: input.pluginId === pluginId ? { targets: { signup: '123' }, code: 'old' } : null } }; },
    async setConversionSettings(input) { requests.push(input.request); return { ok: true, value: { pluginId, declaration, values: input.request.values } }; },
  } };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const textarea = await screen.findByRole('textbox', { name: /^Definition targets/ }) as HTMLTextAreaElement;
  const code = screen.getByRole('textbox', { name: 'Source code' }) as HTMLInputElement;
  expect(textarea.value).toBe('signup=123'); expect(code.value).toBe('old');
  expect(textarea.closest('[data-private]')).toBeNull(); expect(code.closest('[data-private]')).toBeNull();
  fireEvent.change(textarea, { target: { value: ' signup = 1234567890123456789 \n trial=456 ' } });
  fireEvent.change(code, { target: { value: 'source_code' } });
  fireEvent.submit(textarea.form!);
  await screen.findByText('Saved');
  expect(requests).toEqual([{ pluginId, values: { targets: { signup: '1234567890123456789', trial: '456' }, code: 'source_code' } }]);
  const savedTextarea = screen.getByRole('textbox', { name: /^Definition targets/ }) as HTMLTextAreaElement;
  fireEvent.change(savedTextarea, { target: { value: 'signup=123\nsignup=456' } }); fireEvent.submit(savedTextarea.form!);
  await screen.findByText('Enter valid settings; mappings use one unique key=value pair per line.');
  expect(requests).toHaveLength(1);
  view.unmount(); expect(host.pending()).toBe(0);
});
