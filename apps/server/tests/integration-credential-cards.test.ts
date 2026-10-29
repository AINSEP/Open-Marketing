/** Written-only VC1 fixtures. No vendor calls; installed and memory readers share assertions. */
import { expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import { credentialIcon, credentialOAuthClientFields, parseCredentialCardManifest } from '../src/integration-credential-cards.js';
import { bindServerAddons, createNodeAddonEffects } from '../src/composition/addons.js';
import { bindServerIntegrations } from '../src/composition/index.js';
import { createNodeBootIo } from '../src/composition/serve.js';
import { handleIntegrationRequest } from '../src/inbound/integrations.js';

const ns = 'io.github.ainsep.openmarketing';
const context: CallContext = { scope: { ownerId: 'fixture', workspaceId: 'fixture' }, principal: { kind: 'owner', ownerId: 'fixture' }, correlationId: 'fixture-card', traceId: 'fixture-card-trace' };
const path = ns + '/assets/icon.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
const digest = createHash('sha256').update(png).digest('hex');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24">FX</text></svg>');
const icons = [
    { path, bytes: png, digest, contentType: 'image/png' },
    { path: ns + '/assets/icon.svg', bytes: svg, digest: createHash('sha256').update(svg).digest('hex'), contentType: 'image/svg+xml' },
];
const card = { target: 'fixture-plugin', title: 'Fixture', label: 'Save token', category: 'Advertising', intro: 'Fixture token is unverified.',
    usedFor: ['Read fixture campaigns'], helpUrl: 'https://vendor.example/docs', helpLabel: 'Help', baseUrl: 'https://vendor.example', saveKind: 'api-key',
    secretFields: [{ name: 'token', label: 'Token', required: true }], icon: path };
function raw(required: { cards?: unknown[]; assets?: Record<string, string> } = {}): string {
    return JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'fixture-plugin', version: '1.0.0', description: 'Fixture package',
        extensions: { [ns]: { credentialCards: required.cards ?? [card], credentialAssets: required.assets ?? { [path]: digest } } } });
}
function value<T>(result: Outcome<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value; }

it.each([
    { cards: [{ ...card, helpUrl: 'http://vendor.example/docs' }] },
    { cards: [{ ...card, helpUrl: 'https://user:secret@vendor.example/docs' }] },
    { cards: [{ ...card, helpUrl: 'https://vendor.example/?access_token=fixture-secret' }] },
    { cards: [{ ...card, baseUrl: 'https://vendor.example/api' }] },
    { cards: [{ ...card, probeUrl: 'https://other.example/check' }] },
    { cards: [{ ...card, additionalHosts: ['http://other.example'] }] },
    { cards: [card, card] },
    { cards: Array.from({ length: 33 }, (_, index) => ({ ...card, target: 'card-' + index })) },
    { cards: [{ ...card, usedFor: Array(9).fill('Read campaigns') }] },
    { cards: [{ ...card, usedFor: ['x'.repeat(121)] }] },
    { cards: [{ ...card, fields: [{ name: 'token', label: 'Duplicate secret' }] }] },
    { cards: [{ ...card, secretFields: [{ name: 'token', label: 'Token', required: true, value: 'fixture-secret' }] }] },
    { cards: [{ ...card, saveTarget: 'other-plugin' }] },
    { cards: [{ ...card, icon: ns + '/assets/../secret.svg' }] },
    { cards: [{ ...card, icon: ns + '/assets/%2e%2e.svg' }] },
    { assets: { '../secret.png': digest } },
])('rejects unsafe declarations without reflecting input: %j', input => {
    const result = parseCredentialCardManifest({ raw: raw(input), pluginId: 'fixture-plugin' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
});
it.each(['key', 'apiKey', 'APIKEY', 'api_key', 'api-key', '%61piKey', 'accessToken', 'access_token', 'access-token',
    'refreshToken', 'refresh_token', 'clientSecret', 'client_secret', 'authToken', 'authorization', 'auth', 'password', 'secret', 'token'])('rejects credential query alias %s without partial metadata or reflected secrets', key => {
    for (const field of ['helpUrl', 'probeUrl']) {
        const url = 'https://vendor.example/check?lang=en&' + key + '=fixture-secret&' + key + '=second-fixture-secret';
        const result = parseCredentialCardManifest({ raw: raw({ cards: [card, { ...card, target: 'unsafe-card', [field]: url }] }), pluginId: 'fixture-plugin' });
        expect(result).toEqual({ ok: false, error: { code: 'invalid_input', message: 'Invalid credential card or asset', retryable: false } });
        expect(JSON.stringify(result)).not.toContain('fixture-secret');
    }
});
it('preserves credential-free help and same-origin probe query strings', () => {
    const helpUrl = 'https://vendor.example/docs?language=en'; const probeUrl = 'https://vendor.example/check?version=2';
    const parsed = value(parseCredentialCardManifest({ raw: raw({ cards: [{ ...card, helpUrl, probeUrl }] }), pluginId: 'fixture-plugin' }));
    expect(parsed.credentialCards[0]).toMatchObject({ helpUrl, probeUrl });
});
it('bounds whole manifests, identities, aggregate fields and integer metadata', () => {
    expect(parseCredentialCardManifest({ raw: ' '.repeat(65537), pluginId: 'fixture-plugin' }).ok).toBe(false);
    expect(parseCredentialCardManifest({ raw: '{', pluginId: 'fixture-plugin' }).ok).toBe(false);
    expect(parseCredentialCardManifest({ raw: raw(), pluginId: 'foreign' }).ok).toBe(false);
    const fields = Array.from({ length: 16 }, (_, index) => ({ name: 'field' + index, label: 'Field', type: 'integer' }));
    const bundle = { ...card, saveKind: 'app-credentials', fields, secretFields: [] };
    expect(parseCredentialCardManifest({ raw: raw({ cards: [bundle] }), pluginId: 'fixture-plugin' }).ok).toBe(true);
    expect(parseCredentialCardManifest({ raw: raw({ cards: [{ ...bundle, secretFields: card.secretFields }] }), pluginId: 'fixture-plugin' }).ok).toBe(false);
    const parsed = value(parseCredentialCardManifest({ raw: raw({ cards: [{ ...card, saveKind: 'oauth' }], assets: {} }), pluginId: 'fixture-plugin' }));
    expect(parsed.credentialCards[0]).toMatchObject({ pluginId: 'fixture-plugin', saveTarget: 'fixture-plugin', actionSupported: false });
    expect(parsed.credentialCards[0]).not.toHaveProperty('icon');
});

it('keeps a plugin-secret card with multiple declared fields in a mixed card list', () => {
    const secret = { ...card, target: 'fixture-secret', saveKind: 'plugin-secret', secretFields: [
        { name: 'firstSecret', label: 'First', required: true }, { name: 'secondSecret', label: 'Second' },
    ] };
    const parsed = value(parseCredentialCardManifest({ raw: raw({ cards: [card, secret] }), pluginId: 'fixture-plugin' }));
    expect(parsed.credentialCards).toHaveLength(2);
    expect(parsed.credentialCards[1]).toMatchObject({ saveKind: 'plugin-secret', actionSupported: true, secretFields: secret.secretFields });
});

/** Temporary SQLite/lifecycle fixture packages the selected binary icon; module loading is forbidden. */
async function readerFixture(required: { mode: string; icon: typeof icons[number] }) {
    const { mode, icon } = required;
    const manifest = JSON.parse(raw({ cards: [{ ...card, icon: icon.path }], assets: { [icon.path]: icon.digest } }));
    const files = new Map<string, Uint8Array>([[icon.path, icon.bytes],
        [ns + '/assets/button.html', Buffer.from('<button>Fixture</button>')], [ns + '/assets/evidence.json', Buffer.from('{}')]]);
    for (const [name, bytes] of files) manifest.extensions[ns].credentialAssets[name] = createHash('sha256').update(bytes).digest('hex');
    files.set('plugin.json', Buffer.from(JSON.stringify(manifest)));
    const denied = { ok: false as const, error: { code: 'forbidden' as const, message: 'Fixture reader denied', retryable: false } };
    if (mode === 'memory') return {
        async readCredentialCards(input: { context: CallContext; pluginId: string }) {
            if (input.context.scope.workspaceId !== context.scope.workspaceId) return denied;
            return parseCredentialCardManifest({ raw: Buffer.from(files.get('plugin.json')!).toString(), pluginId: input.pluginId });
        },
        async readCredentialAsset(input: { context: CallContext; pluginId: string; path: string }) {
            if (input.pluginId !== 'fixture-plugin' || !manifest.extensions[ns].credentialAssets[input.path]) return denied;
            return { ok: true as const, value: files.get(input.path)! };
        }, async dispose() {},
    };
    const root = await fs.mkdtemp(join(tmpdir(), 'om-vc1-'));
    const native = new Database(':memory:');
    native.exec(await fs.readFile(new URL('../migrations/0002_addons.sql', import.meta.url), 'utf8'));
    const db: CredentialSqlPort = { async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
        const statement = native.prepare(input.text); const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
        if (statement.reader) { const rows = statement.all(parameters) as Row[]; return { rows, rowCount: rows.length }; }
        return { rows: [], rowCount: statement.run(parameters).changes };
    } };
    const clock = { now: () => 1000 }; const ids = { next: () => 'fixture' };
    const binding = bindServerAddons({ context, db, stateRoot: root, projectRoot: root, clock, observer: { observe() {} },
        audit: { async record() { return { ok: true as const, value: undefined }; } }, async runningJobs() { return { ok: true as const, value: 0 }; },
        effects: createNodeAddonEffects({ clock, ids, async loadModule() { throw new Error('Cards must never import modules'); } }),
        yamlReader: { read: ({ yaml }) => JSON.parse(yaml) }, sessions: { async reload() {}, async close() {} } });
    if (mode === 'bundled') {
        for (const [name, bytes] of files) { const destination = join(root, 'content/agent-plugins/fixture-plugin', name); await fs.mkdir(join(destination, '..'), { recursive: true }); await fs.writeFile(destination, bytes); }
        value(await binding.start());
    } else value(await binding.addons.install({ context, request: { kind: 'agent-plugin', upload: { kind: 'files',
        files: [...files].map(([name, bytes]) => ({ path: name, base64: Buffer.from(bytes).toString('base64') })) } } }));
    return { ...binding, async dispose() { await binding.dispose(); native.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
it.each(['memory', 'uploaded', 'bundled'].flatMap(mode => icons.map(icon => ({ mode, icon }))))('$mode readers preserve and deliver exact $icon.contentType/specimen/evidence bytes', async ({ mode, icon }) => {
    const f = await readerFixture({ mode, icon });
    try {
        const cards = value(await f.readCredentialCards({ context, pluginId: 'fixture-plugin' }));
        expect(cards.credentialCards[0]).toMatchObject({ actionSupported: true, pluginId: 'fixture-plugin', icon: icon.path, iconDigest: icon.digest });
        const bytes = value(await f.readCredentialAsset({ context, pluginId: 'fixture-plugin', path: icon.path }));
        expect(Buffer.from(bytes)).toEqual(icon.bytes);
        expect(credentialIcon({ path: icon.path, digest: icon.digest, bytes })).toEqual({ ok: true, value: { bytes, contentType: icon.contentType } });
        for (const [name, expected] of [['button.html', '<button>Fixture</button>'], ['evidence.json', '{}']]) expect(Buffer.from(value(await f.readCredentialAsset({ context, pluginId: 'fixture-plugin', path: ns + '/assets/' + name })))).toEqual(Buffer.from(expected));
        const integrations = bindServerIntegrations({ ...f, db: { async query() { throw new Error('Icon delivery must not read credentials'); } },
            clock: { now: () => 1000 }, ids: { next: () => 'fixture' }, observer: { observe() {} }, stateRoot: '/fixture',
            io: createNodeBootIo({ projectRoot: '/fixture', studioRoot: '/fixture', ready() {} }) });
        const response = await handleIntegrationRequest({ context, integrations, request: { method: 'GET', path: '/api/addons/v1/integrations/credential-asset', query: { pluginId: 'fixture-plugin', digest: icon.digest } } });
        expect(response).toEqual({ status: 200, body: icon.bytes, contentType: icon.contentType,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'" } });
        expect(await f.readCredentialCards({ context: { ...context, scope: { ...context.scope, workspaceId: 'foreign' } }, pluginId: 'fixture-plugin' })).toMatchObject({ ok: false });
        expect(await f.readCredentialAsset({ context, pluginId: 'fixture-plugin', path: '../plugin.json' })).toMatchObject({ ok: false });
    } finally { await f.dispose(); }
});
it('rejects corrupt, oversized and mismatched icon payloads', () => {
    expect(credentialIcon({ path, digest, bytes: Buffer.from('corrupt') }).ok).toBe(false);
    expect(credentialIcon({ path, digest, bytes: new Uint8Array(262145) }).ok).toBe(false);
    expect(credentialIcon({ path: path.replace('.png', '.html'), digest, bytes: png }).ok).toBe(false);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(credentialIcon({ path: path.replace('.png', '.svg'), digest: createHash('sha256').update(svg).digest('hex'), bytes: svg })).toMatchObject({ ok: true, value: { contentType: 'image/svg+xml' } });
});
it.each(['google-ads', 'meta-ads', 'linkedin-ads', 'tiktok-ads', 'higgsfield-media',
    'amazon-ses', 'apple-search-ads', 'google-business-profile', 'kakao-ads', 'line-ads', 'microsoft-ads', 'naver-ads', 'pinterest-ads',
    'reddit-ads', 'resend-email', 'snapchat-ads', 'twilio-sms', 'vk-ads', 'whatsapp-business', 'x-ads', 'yandex-direct',
])('%s ships valid identity-bound cards and all declared asset digests', async pluginId => {
    const root = new URL('../../../content/agent-plugins/' + pluginId + '/', import.meta.url);
    const raw = await fs.readFile(new URL('plugin.json', root), 'utf8');
    expect(JSON.parse(raw).$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    const parsed = value(parseCredentialCardManifest({ raw, pluginId }));
    expect(parsed.credentialCards.length).toBeGreaterThan(0);
    for (const [path, digest] of Object.entries(parsed.credentialAssets)) expect(createHash('sha256').update(await fs.readFile(new URL(path, root))).digest('hex')).toBe(digest);
    expect(parsed.credentialCards.every(card => card.saveTarget === pluginId)).toBe(true);
    if (pluginId === 'higgsfield-media') expect(parsed.credentialCards[0].actionSupported).toBe(false);
    if (pluginId === 'tiktok-ads') expect(parsed.credentialCards[0].saveKind).toBe('api-key');
});

it('disables empty plugin-secret actions from declarations', () => {
    const parsed = value(parseCredentialCardManifest({ pluginId: 'fixture-plugin', raw: raw({ cards: [
        { ...card, saveKind: 'plugin-secret', secretFields: [] },
    ] }) }));
    expect(parsed.credentialCards.map(card => card.actionSupported)).toEqual([false]);
});

it('derives unique OAuth extras from public fields only across client cards', () => {
    const parsed = value(parseCredentialCardManifest({ pluginId: 'fixture-plugin', raw: raw({ cards: [
        { ...card, saveKind: 'oauth-client', fields: [{ name: 'clientId', label: 'ID' }, { name: 'tenant', label: 'Tenant' }], secretFields: [{ name: 'clientSecret', label: 'Secret' }] },
        { ...card, target: 'fixture-second', saveKind: 'oauth-client', fields: [{ name: 'tenant', label: 'Tenant' }, { name: 'region', label: 'Region' }], secretFields: [] },
        { ...card, target: 'fixture-app', saveKind: 'app-credentials', fields: [{ name: 'ignored', label: 'Ignored' }], secretFields: [] },
    ] }) }));
    expect(credentialOAuthClientFields({ cards: parsed.credentialCards })).toEqual(['tenant', 'region']);
});
