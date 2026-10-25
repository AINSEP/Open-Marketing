/** D3 written-only HTTP parity and secret-handling cases. All effects are fixtures. */
import { describe, expect, it } from 'vitest';
import { runOmCli } from '../../src/cli/index.js';
import type { CliRuntime } from '../../src/cli/index.js';
import { handleOwnerRequest } from '../../src/inbound/owner.js';
import type { OwnerServices } from '../../src/inbound/owner.js';
import type { CallContext } from '@open-marketing/contracts';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderReader } from '../../src/cli/folder.js';

const addon = { id: 'fixture-plugin', kind: 'plugin', name: 'Fixture', description: 'Fixture only', version: '1', enabled: false, revision: 'r1' };
const connection = { connectionId: 'account-one', pluginId: 'anthropic', status: 'saved' };
/** Native HTTP/stdin/folder doubles retain exact submitted bodies for direct assertions. */
function fixture(required: { value?: unknown; failure?: string }) {
  const calls: { url: string; init?: RequestInit; body: unknown }[] = [];
  const stdout: string[] = []; const stderr: string[] = []; const reads: string[] = [];
  let id = 0; let disposed = 0;
  const runtime: CliRuntime = {
    env: { OM_SERVER_URL: 'http://fixture.test', OM_OWNER_TOKEN: 'fixture-owner' },
    clock: { now: () => 1000 }, ids: { next: () => 'fixture-id-' + ++id },
    stdout: { write: ({ text }) => { stdout.push(text); } }, stderr: { write: ({ text }) => { stderr.push(text); } },
    async confirm() { throw new Error('No independent approval system'); },
    deadline: { create() { return { signal: new AbortController().signal, dispose() { disposed++; } }; } },
    async *readPrompt({ path }) { reads.push(path); yield Buffer.from(path === '-' ? 'fixture-secret-stdin' : 'fixture-zip-bytes'); },
    addonFiles: { async readFolder({ path }) { reads.push(path); return { kind: 'files', files: [{ path: 'jini.plugin.json', base64: 'e30=' }] }; } },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const result = required.failure ? { ok: false, error: { code: 'unavailable', message: required.failure, retryable: false } } : { ok: true, value: required.value };
      return Response.json(result, { status: required.failure ? 503 : 200 });
    },
  };
  return { runtime, calls, stdout, stderr, reads, disposed: () => disposed };
}
describe('add-on command parity', () => {
  it.each([
    { argv: ['addons', 'list', '--kind', 'plugin'], path: '/api/addons/v1/packages?limit=25&kind=plugin', method: 'GET', value: { items: [addon], cursor: null }, body: undefined },
    { argv: ['addons', 'enable', 'fixture-plugin', '--kind', 'plugin'], path: '/api/addons/v1/set-enabled', method: 'POST', value: { ...addon, enabled: true }, body: { kind: 'plugin', id: 'fixture-plugin', enabled: true } },
    { argv: ['addons', 'disable', 'fixture-plugin', '--kind', 'plugin'], path: '/api/addons/v1/set-enabled', method: 'POST', value: addon, body: { kind: 'plugin', id: 'fixture-plugin', enabled: false } },
    { argv: ['addons', 'uninstall', 'fixture-plugin', '--kind', 'plugin'], path: '/api/addons/v1/uninstall', method: 'POST', value: { kind: 'plugin', id: 'fixture-plugin', removed: true }, body: { kind: 'plugin', id: 'fixture-plugin' } },
    { argv: ['integrations', 'list'], path: '/api/addons/v1/integrations?limit=25', method: 'GET', value: { items: [connection], cursor: null }, body: undefined },
    { argv: ['integrations', 'disconnect', 'account-one'], path: '/api/addons/v1/integrations/disconnect', method: 'POST', value: { ...connection, status: 'disconnected' }, body: { connectionId: 'account-one' } },
  ])('routes $argv through the authenticated owner transport', async ({ argv, path, method, value, body }) => {
    const f = fixture({ value });
    expect(await runOmCli({ argv: [...argv, '--json'], runtime: f.runtime })).toEqual({ ok: true, value: undefined });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: 'http://fixture.test' + path, body, init: { method, redirect: 'error' } });
    expect(new Headers(f.calls[0].init?.headers).get('authorization')).toBe('Bearer fixture-owner');
    expect(f.disposed()).toBe(1);
  });
  it.each(['bundle.zip', 'bundle-folder'])('uploads %s through the single install endpoint', async path => {
    const f = fixture({ value: addon });
    expect((await runOmCli({ argv: ['addons', 'install', path, '--kind', 'plugin', '--json'], runtime: f.runtime })).ok).toBe(true);
    expect(f.reads).toEqual([path]); expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://fixture.test/api/addons/v1/install');
    expect(f.calls[0].body).toMatchObject({ kind: 'plugin', upload: { kind: path.endsWith('.zip') ? 'zip' : 'files' } });
  });
  it('reads the exact token from stdin once and returns only the saved summary', async () => {
    const f = fixture({ value: connection });
    expect((await runOmCli({ argv: ['integrations', 'connect', '--plugin', 'anthropic', '--connection', 'account-one', '--token-stdin', '--json'], runtime: f.runtime })).ok).toBe(true);
    expect(f.calls[0].body).toEqual({ pluginId: 'anthropic', connectionId: 'account-one', plaintext: 'fixture-secret-stdin' });
    expect(f.reads).toEqual(['-']); expect(f.calls).toHaveLength(1);
    expect(f.stdout.join('')).not.toContain('fixture-secret'); expect(f.stderr).toEqual([]);
  });
  it('redacts tainted server failures and performs no retry after a connection write', async () => {
    const f = fixture({ failure: 'fixture-secret-stdin' });
    expect((await runOmCli({ argv: ['integrations', 'connect', '--plugin', 'anthropic', '--token-stdin', '--json'], runtime: f.runtime })).ok).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.stdout.join('') + f.stderr.join('')).not.toContain('fixture-secret');
  });
  it.each([
    ['integrations', 'connect', '--plugin', 'anthropic', '--token', 'fixture-secret'],
    ['integrations', 'connect', 'fixture-secret', '--token-stdin'],
    ['addons', 'list', '--kind', 'plugin', '--kind', 'skill'],
    ['addons', 'enable', 'one', '--kind', 'future'],
    ['integrations', 'list', '--kind', 'plugin'],
    ['addons', 'uninstall', 'one', 'extra', '--kind', 'plugin'],
  ])('rejects malformed command %s before any read or HTTP effect', async (...argv) => {
    const f = fixture({});
    expect((await runOmCli({ argv, runtime: f.runtime })).ok).toBe(false);
    expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
  });
  it('help needs neither credentials nor I/O', async () => {
    const f = fixture({});
    expect((await runOmCli({ argv: ['addons', '--help'], runtime: { ...f.runtime, env: {} } })).ok).toBe(true);
    expect(f.stdout.join('')).toContain('--token-stdin'); expect(f.calls).toEqual([]);
  });
  it('refuses malformed response contracts', async () => {
    const f = fixture({ value: { ...connection, plaintext: 'should-not-display' } });
    expect((await runOmCli({ argv: ['integrations', 'connect', '--plugin', 'anthropic', '--token-stdin', '--json'], runtime: f.runtime })).ok).toBe(false);
    expect(f.stdout.join('')).not.toContain('should-not-display');
  });
});
it('mounts authenticated D2 owner routes and denies bodies for the wrong principal', async () => {
  const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
  const services = { addons: { async list() { return { ok: true, value: { items: [addon], cursor: null } }; } } } as unknown as OwnerServices;
  const response = await handleOwnerRequest({ request: { method: 'GET', path: '/api/addons/v1/packages', query: { limit: '25' } }, context, services });
  expect(response).toMatchObject({ status: 200, body: { ok: true, value: { items: [addon] } } });
  let reads = 0;
  const denied = await handleOwnerRequest({ request: { method: 'POST', path: '/api/addons/v1/install', async readBody() { reads++; return { ok: true, value: {} }; } }, context: { ...context, principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' } }, services });
  expect(denied.status).toBe(403); expect(reads).toBe(0);
});

it.each(['memory', 'native'] as const)('%s folder port preserves relative binary files and the CLI submits one upload', async adapter => {
  const root = await fs.mkdtemp(join(tmpdir(), 'om-addon-folder-'));
  try {
    await fs.mkdir(join(root, 'client'));
    await fs.writeFile(join(root, 'jini.plugin.json'), '{}');
    await fs.writeFile(join(root, 'client', 'asset.bin'), Buffer.from([0, 255, 1]));
    const addonFiles = adapter === 'native' ? createFolderReader({ fs }) : {
      async readFolder() { return { kind: 'files' as const, files: [{ path: 'client/asset.bin', base64: 'AP8B' }, { path: 'jini.plugin.json', base64: 'e30=' }] }; },
    };
    expect(await addonFiles.readFolder({ path: root, signal: new AbortController().signal })).toEqual({ kind: 'files', files: [
      { path: 'client/asset.bin', base64: 'AP8B' }, { path: 'jini.plugin.json', base64: 'e30=' },
    ] });
    const f = fixture({ value: addon });
    expect((await runOmCli({ argv: ['addons', 'install', root, '--kind', 'plugin', '--json'], runtime: { ...f.runtime, addonFiles } })).ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body).toMatchObject({ kind: 'plugin', upload: { kind: 'files', files: [{ path: 'client/asset.bin', base64: 'AP8B' }, { path: 'jini.plugin.json', base64: 'e30=' }] } });
    expect(await fs.readFile(join(root, 'client', 'asset.bin'))).toEqual(Buffer.from([0, 255, 1]));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['empty', 'file-link', 'directory-link', 'root-link', 'aggregate-cap', 'depth-cap', 'aborted'])('refuses %s folders before any HTTP submission', async mode => {
  const root = await fs.mkdtemp(join(tmpdir(), 'om-addon-refused-'));
  let path = root;
  const controller = new AbortController();
  try {
    if (mode === 'file-link') await fs.symlink('/outside-fixture', join(root, 'link'));
    if (mode === 'directory-link') await fs.symlink(tmpdir(), join(root, 'directory'));
    if (mode === 'root-link') { path = join(root, 'root-link'); await fs.symlink(tmpdir(), path); }
    if (mode === 'aggregate-cap') {
      for (const name of ['a.bin', 'b.bin']) { const file = await fs.open(join(root, name), 'w'); await file.truncate(20000000); await file.close(); }
    }
    if (mode === 'depth-cap') await fs.mkdir(join(root, ...Array.from({ length: 17 }, () => 'nested')), { recursive: true });
    if (mode === 'aborted') controller.abort();
    const f = fixture({ value: addon });
    const result = await runOmCli({ argv: ['addons', 'install', path, '--json'], runtime: { ...f.runtime, signal: controller.signal, addonFiles: createFolderReader({ fs }) } });
    expect(result.ok).toBe(false); expect(f.calls).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


it('maps OAuth start/status and stdin-only callback without printing callback codes or tokens', async () => {
  const challenge = { transactionId: 'sign-in', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state', expiresAt: 301000 };
  for (const input of [
    { argv: ['integrations', 'oauth', 'start', '--plugin', 'google-ads', '--json'], value: { status: 'completed', output: challenge }, path: '/oauth/start' },
    { argv: ['integrations', 'oauth', 'status', '--transaction', 'sign-in', '--json'], value: { status: 'complete', connection }, path: '/oauth/status?transactionId=sign-in' },
    { argv: ['integrations', 'oauth', 'status', '--plugin', 'fixture-vendor', '--json'], value: { configured: false, credentialCards: [], connections: [], connectionsCursor: null }, path: '/oauth/status?pluginId=fixture-vendor' },
    { argv: ['integrations', 'oauth', 'callback', '--response-stdin', '--json'], value: connection, path: '/oauth/callback' },
  ]) {
    const f = fixture({ value: input.value });
    const runtime = { ...f.runtime, async *readPrompt() { yield Buffer.from(JSON.stringify({ state: 'fixture-state', code: 'fixture-code-secret' })); } };
    expect((await runOmCli({ argv: input.argv, runtime })).ok).toBe(true);
    expect(f.calls[0].url).toContain(input.path);
    expect(f.calls[0].init?.headers).toMatchObject({ authorization: 'Bearer fixture-owner' });
    expect(f.stdout.join('') + f.stderr.join('')).not.toContain('fixture-code-secret');
    if (input.path.endsWith('callback')) expect(f.calls[0].body).toEqual({ state: 'fixture-state', code: 'fixture-code-secret' });
  }
});
it.each([
  ['integrations', 'oauth', 'client', 'set', '--plugin', 'google-ads', '--client-secret', 'fixture-code-secret'],
  ['integrations', 'oauth', 'client', 'set', '--plugin', 'google-ads', 'fixture-code-secret'],
  ['integrations', 'oauth', 'callback', '--code', 'fixture-code-secret'],
  ['integrations', 'oauth', 'start', '--plugin', 'google-ads', '--response-stdin'],
  ['integrations', 'oauth', 'callback', '--response-stdin', 'fixture-code-secret'],
  ['integrations', 'oauth', 'status', '--transaction', 'one', '--transaction', 'two'],
  ['integrations', 'oauth', 'status', '--transaction', 'one', '--plugin', 'google-ads'],
  ['integrations', 'oauth', 'status'],
])('rejects invalid OAuth argv before I/O: %s', async (...argv) => {
  const f = fixture({});
  expect((await runOmCli({ argv, runtime: f.runtime })).ok).toBe(false);
  expect(f.calls).toEqual([]); expect(f.reads).toEqual([]);
  expect(f.stdout.join('') + f.stderr.join('')).not.toContain('fixture-code-secret');
});
it('rejects a malformed completed start response before printing extra secret fields', async () => {
  const f = fixture({ value: { status: 'completed', output: { transactionId: 'sign-in', authorizationUrl: 'https://fixture.test', expiresAt: 301000, refreshToken: 'fixture-secret' } } });
  expect((await runOmCli({ argv: ['integrations', 'oauth', 'start', '--plugin', 'google-ads', '--json'], runtime: f.runtime })).ok).toBe(false);
  expect(f.stdout.join('') + f.stderr.join('')).not.toContain('fixture-secret');
});

it.each(['google-ads', 'meta-ads'])('sets %s client JSON from stdin and clears without stdin, returning only configuration status', async pluginId => {
  const client = { clientId: 'fixture-client', clientSecret: 'fixture-client-secret', ...(pluginId === 'meta-ads' ? { configId: '999' } : {}) };
  const f = fixture({ value: { configured: true, clientId: client.clientId } });
  const runtime = { ...f.runtime, async *readPrompt() { f.reads.push('-'); yield Buffer.from(JSON.stringify(client)); } };
  expect((await runOmCli({ argv: ['integrations', 'oauth', 'client', 'set', '--plugin', pluginId, '--json'], runtime })).ok).toBe(true);
  expect(f.reads).toEqual(['-']); expect(f.calls[0].body).toEqual({ pluginId, client });
  expect(f.stdout.join('') + f.stderr.join('')).not.toContain(client.clientSecret);
  const clear = fixture({ value: { configured: false } });
  expect((await runOmCli({ argv: ['integrations', 'oauth', 'client', 'clear', '--plugin', pluginId], runtime: clear.runtime })).ok).toBe(true);
  expect(clear.reads).toEqual([]); expect(clear.calls[0].body).toEqual({ pluginId, client: null });
});

it('keeps TikTok on the existing stdin paste-token command', async () => {
  const f = fixture({ value: { ...connection, pluginId: 'tiktok-ads' } });
  expect((await runOmCli({ argv: ['integrations', 'connect', '--plugin', 'tiktok-ads', '--connection', 'account-one', '--token-stdin', '--json'], runtime: f.runtime })).ok).toBe(true);
  expect(f.calls[0].body).toEqual({ pluginId: 'tiktok-ads', connectionId: 'account-one', plaintext: 'fixture-secret-stdin' });
  expect(f.stdout.join('') + f.stderr.join('')).not.toContain('fixture-secret-stdin');
});

it('sets the Google developer token from stdin and exposes only configured status', async () => {
  const token = 'A'.repeat(22); const f = fixture({ value: { configured: true } });
  const runtime = { ...f.runtime, async *readPrompt() { f.reads.push('-'); yield Buffer.from(token + '\n'); } };
  expect((await runOmCli({ argv: ['integrations', 'developer-token', 'set', '--plugin', 'google-ads', '--json'], runtime })).ok).toBe(true);
  expect(f.reads).toEqual(['-']); expect(f.calls[0].url).toBe('http://fixture.test/api/addons/v1/integrations/developer-token');
  expect(f.calls[0].body).toEqual({ pluginId: 'google-ads', token }); expect(f.stdout.join('') + f.stderr.join('')).not.toContain(token);
  for (const action of ['clear', 'status']) {
    const next = fixture({ value: { configured: false } });
    expect((await runOmCli({ argv: ['integrations', 'developer-token', action, '--plugin', 'google-ads', '--json'], runtime: next.runtime })).ok).toBe(true);
    expect(next.reads).toEqual([]); expect(next.calls[0].init?.method).toBe(action === 'status' ? 'GET' : 'POST');
    expect(next.calls[0].body).toEqual(action === 'status' ? undefined : { pluginId: 'google-ads', token: null });
  }
});
it.each([
  ['integrations', 'developer-token', 'set', '--plugin', 'google-ads', '--token', 'secret-argv'],
  ['integrations', 'developer-token', 'set', '--plugin', 'google-ads', 'secret-argv'],
  ['integrations', 'developer-token', 'set', '--plugin', 'meta-ads'],
])('rejects developer-token argv secrets and other plugins before I/O: %s', async (...argv) => {
  const f = fixture({}); expect((await runOmCli({ argv, runtime: f.runtime })).ok).toBe(false);
  expect(f.calls).toEqual([]); expect(f.reads).toEqual([]); expect(f.stdout.join('') + f.stderr.join('')).not.toContain('secret-argv');
});
