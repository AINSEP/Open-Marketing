/** @vitest-environment jsdom */
/** Written-only D3 contracts: sample/HTTP share lifecycle assertions; no live egress. */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
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
      case '/api/addons/v1/integrations/oauth/client': outcome = await required.api.setOAuthClient({ request }); break;
      case '/api/addons/v1/integrations/oauth/status': outcome = await required.api.oauthStatus({ query: url.searchParams.has('pluginId') ? { pluginId: url.searchParams.get('pluginId') as 'google-ads' } : { transactionId: url.searchParams.get('transactionId')! } }); break;
      case '/api/addons/v1/integrations/developer-token': outcome = init?.method === 'POST' ? await required.api.setDeveloperToken({ request }) : await required.api.developerTokenStatus({ pluginId: 'google-ads' }); break;
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
    it('sets, reads, replaces and clears sealed client/developer configuration without returning secrets', async () => {
      const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
      const api = adapter === 'sample' ? sample : createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: transport({ api: sample.addons!, calls: [] }) });
      const addons = api.addons!;
      expect(await addons.oauthStatus({ query: { pluginId: 'google-ads' } })).toEqual({ ok: true, value: { configured: false } });
      const saved = await addons.setOAuthClient({ request: { pluginId: 'google-ads', client: { clientId: 'client-one', clientSecret: 'private-client-fixture' } } });
      expect(saved).toEqual({ ok: true, value: { configured: true, clientId: 'client-one' } });
      expect(await addons.oauthStatus({ query: { pluginId: 'google-ads' } })).toEqual(saved);
      expect(await addons.oauthStatus({ query: { pluginId: 'linkedin-ads' } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.setOAuthClient({ request: { pluginId: 'meta-ads', client: { clientId: 'meta', clientSecret: 'private-meta', configId: '123' } } })).toMatchObject({ ok: true });
      expect(await addons.setOAuthClient({ request: { pluginId: 'google-ads', client: { clientId: 'client-two' } } })).toMatchObject({ ok: true, value: { clientId: 'client-two' } });
      expect(await addons.setOAuthClient({ request: { pluginId: 'google-ads', client: null } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.oauthStatus({ query: { pluginId: 'google-ads' } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.setDeveloperToken({ request: { pluginId: 'google-ads', token: 'A'.repeat(22) } })).toEqual({ ok: true, value: { configured: true } });
      expect(await addons.developerTokenStatus({ pluginId: 'google-ads' })).toEqual({ ok: true, value: { configured: true } });
      expect(await addons.setDeveloperToken({ request: { pluginId: 'google-ads', token: null } })).toEqual({ ok: true, value: { configured: false } });
      expect(await addons.developerTokenStatus({ pluginId: 'google-ads' })).toEqual({ ok: true, value: { configured: false } });
      expect(JSON.stringify(saved)).not.toContain('private-client-fixture');
      expect(await addons.integrations({ query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
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

it('keeps client secrets private and clears them before a failed owner request', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<StudioApiPort['addons']>['setOAuthClient']>>>();
  const requests: unknown[] = [];
  const api: StudioApiPort = { ...sample, addons: { ...sample.addons!, setOAuthClient: input => { requests.push(input.request); return pending.promise; } } };
  render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const google = within(screen.getByRole('region', { name: 'Google integration' }));
  await waitFor(() => expect(google.getByText('Client configuration required')).toBeDefined());
  fireEvent.click(google.getByText('OAuth client configuration'));
  fireEvent.change(google.getByLabelText('Client ID'), { target: { value: 'fixture-client' } });
  fireEvent.change(google.getByLabelText('Client secret'), { target: { value: 'fixture-private-client' } });
  expect(google.getByLabelText('Client secret').closest('[data-agent-private]')).toBeTruthy();
  fireEvent.click(google.getByRole('button', { name: 'Save client configuration' }));
  expect((google.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(requests).toEqual([{ pluginId: 'google-ads', client: { clientId: 'fixture-client', clientSecret: 'fixture-private-client' } }]);
  await act(async () => pending.resolve({ ok: false, error: { code: 'unavailable', message: 'fixture-private-client', retryable: false } }));
  expect(google.getByRole('alert').textContent).not.toContain('fixture-private-client');
});
it('starts sign-in through one policy card and reads its operation before offering an expiring HTTPS link', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  await sample.addons!.setOAuthClient({ request: { pluginId: 'google-ads', client: { clientId: 'fixture-client' } } });
  let operationId = ''; const names: string[] = []; let approved = false;
  const api: StudioApiPort = { ...sample,
    async tool(input) { names.push(input.call.name); operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async approvalCard() { return { ok: true, value: { cardId: 'oauth-card', operationId, argumentsDigest: 'a'.repeat(64), arguments: { tool: 'integrations_oauth_start', input: { pluginId: 'google-ads' } }, classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 } }; },
    async approve() { approved = true; return { ok: true, value: { status: 'recorded' } }; },
    async operation() { return approved ? { ok: true, value: { status: 'completed', operationId, output: { transactionId: 'transaction', authorizationUrl: 'https://accounts.example.test/authorize?state=fixture', expiresAt: 61000 } } } : { ok: true, value: { status: 'pending', operationId } }; },
  };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const google = within(screen.getByRole('region', { name: 'Google integration' }));
  await waitFor(() => expect((google.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(google.getByRole('button', { name: 'Sign in with Google' }));
  await waitFor(() => expect(google.getByRole('article', { name: 'Review tool call' })).toBeDefined());
  expect(google.queryByRole('link', { name: 'Continue to Google' })).toBeNull();
  fireEvent.click(google.getByRole('button', { name: /^Allow$/ }));
  await waitFor(() => expect(approved).toBe(true));
  fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  await waitFor(() => expect(google.getByRole('link', { name: 'Continue to Google' }).getAttribute('href')).toContain('https://accounts.example.test/'));
  expect(names).toEqual(['integrations_oauth_start']);
  await act(async () => host.advance({ ms: 60000 }));
  expect(google.queryByRole('link', { name: 'Continue to Google' })).toBeNull();
  view.unmount(); expect(host.pending()).toBe(0);
});

/** An unknown start may already have reached the provider; status reads must keep the same identity. */
it.each(['cancelled', 'interrupted', 'completed'] as const)('blocks another OAuth start while unknown, until reconciled as %s', async terminal => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  await sample.addons!.setOAuthClient({ request: { pluginId: 'google-ads', client: { clientId: 'fixture-client' } } });
  let operationId = ''; let starts = 0; let reconciled = false; const reads: string[] = [];
  const api: StudioApiPort = { ...sample,
    async tool(input) { starts++; operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
    async approvalCard() { return { ok: true, value: oauthCard({ operationId }) }; },
    async operation(input) {
      reads.push(input.operationId);
      if (!reconciled) return { ok: true, value: { status: 'unknown', operationId, error: { code: 'unavailable', message: 'Fixture outcome unknown', retryable: false } } };
      if (terminal === 'completed') return { ok: true, value: { status: 'completed', operationId, output: { transactionId: 'reconciled-transaction', authorizationUrl: 'https://accounts.example.test/reconciled', expiresAt: 1000000 } } };
      return { ok: true, value: { status: terminal, operationId } };
    },
  };
  const view = render(createElement(IntegrationsPage, { api, runtime: host.runtime }));
  const google = within(screen.getByRole('region', { name: 'Google integration' }));
  const signIn = google.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement;
  await waitFor(() => expect(signIn.disabled).toBe(false));
  fireEvent.click(signIn);
  await waitFor(() => expect(google.getByRole('article', { name: 'Review tool call' })).toBeDefined());
  const originalId = operationId;
  fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  await waitFor(() => expect(google.getByText('Sign-in outcome unresolved. Check status again before starting another sign-in.')).toBeDefined());
  expect(google.queryByRole('article', { name: 'Review tool call' })).toBeNull();
  await act(async () => host.advance({ ms: 300001 }));
  expect(signIn.disabled).toBe(true); fireEvent.click(signIn); expect(starts).toBe(1);
  fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(reads).toEqual([originalId, originalId]); expect(signIn.disabled).toBe(true);
  reconciled = true;
  await waitFor(() => expect((google.getByRole('button', { name: 'Check Google sign-in status' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  if (terminal === 'completed') {
    await waitFor(() => expect(google.getByRole('link', { name: 'Continue to Google' }).getAttribute('href')).toBe('https://accounts.example.test/reconciled'));
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
  await sample.addons!.setOAuthClient({ request: { pluginId: 'google-ads', client: { clientId: 'fixture-client' } } });
  let operationId = ''; let starts = 0; let repaired = false; const cards: string[] = []; const operations: string[] = [];
  const api: StudioApiPort = { ...sample,
    async tool(input) { starts++; operationId = input.call.operationId; return { ok: true, value: { status: 'pending', operationId, cardId: 'oauth-card' } }; },
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
  const google = within(screen.getByRole('region', { name: 'Google integration' }));
  const signIn = google.getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement;
  await waitFor(() => expect(signIn.disabled).toBe(false)); fireEvent.click(signIn);
  await waitFor(() => expect(google.getByRole('alert').textContent).toContain('Sign-in approval unavailable.'));
  expect(signIn.disabled).toBe(true); expect(google.queryByRole('button', { name: /^Allow$/ })).toBeNull();
  fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  if (evidence !== 'valid') {
    await waitFor(() => expect(google.getByRole('alert').textContent).toBe('Sign-in approval identity mismatch.'));
    expect(google.queryByRole('button', { name: /^Allow$/ })).toBeNull(); expect(signIn.disabled).toBe(true);
    repaired = true; fireEvent.click(google.getByRole('button', { name: 'Check Google sign-in status' }));
  }
  await waitFor(() => expect(google.getByRole('button', { name: /^Allow$/ })).toBeDefined());
  expect(starts).toBe(1); expect(cards).toEqual(Array(evidence === 'valid' ? 2 : 3).fill('oauth-card'));
  expect(operations).toEqual(Array(evidence === 'valid' ? 1 : 2).fill(operationId));
  view.unmount(); expect(host.pending()).toBe(0);
});

function oauthCard(required: { operationId: string }): import('@open-marketing/contracts').ConfirmationCard {
  return { cardId: 'oauth-card', operationId: required.operationId, argumentsDigest: 'a'.repeat(64), arguments: { tool: 'integrations_oauth_start', input: { pluginId: 'google-ads' } }, classification: 'write', allowedChoices: ['allow', 'cancel'], expiresAt: 301000 };
}

it('clears a Google developer token before dispatch and does not claim a connection was verified', async () => {
  const host = testRuntime(); const sample = createSampleStudioApi({ runtime: host.runtime });
  render(createElement(IntegrationsPage, { api: sample, runtime: host.runtime }));
  const developer = within(screen.getByRole('region', { name: 'Google developer token' }));
  await waitFor(() => expect(developer.getByText('Developer token not configured')).toBeDefined());
  fireEvent.change(developer.getByLabelText('Developer token'), { target: { value: 'A'.repeat(22) } });
  fireEvent.click(developer.getByRole('button', { name: 'Save developer token' }));
  expect((developer.getByLabelText('Developer token') as HTMLInputElement).value).toBe('');
  await waitFor(() => expect(developer.getByText('Developer token configured')).toBeDefined());
  expect(screen.queryByText('Connection verified')).toBeNull();
});
it('rejects malformed owner configuration before HTTP and rejects tainted status replies', async () => {
  const host = testRuntime(); let calls = 0;
  const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async () => { calls++; return Response.json({ ok: true, value: { configured: true, clientId: 'fixture', clientSecret: 'must-not-arrive' } }); } });
  expect((await api.addons!.setOAuthClient({ request: { pluginId: 'meta-ads', client: { clientId: 'fixture', configId: 'invalid' } } })).ok).toBe(false);
  expect(calls).toBe(0);
  expect((await api.addons!.oauthStatus({ query: { pluginId: 'google-ads' } })).ok).toBe(false);
  expect(calls).toBe(1);
});
