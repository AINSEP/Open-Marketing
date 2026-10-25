/** Declarative metadata only; no declaration executes code or grants authority.
 * Host forms bind pluginId/saveTarget to the installed package, never a submitted field.
 * oauth -> existing policy-controlled start; oauth-client -> existing sealed client route.
 * api-key -> sealed token plaintext; app-credentials -> exact JSON of declared public/password
 * fields (integer fields stay numbers); developer-token -> existing Google compatibility route.
 * Secret values travel directly to owner ingress, never tool arguments, status or logs.
 * Zod callbacks below use its fixed value/context ABI.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { idSchema, integrationSummarySchema } from '@open-marketing/contracts';
import type { Outcome } from '@open-marketing/contracts';

const text = z.string().trim().min(1).max(512);
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const credentialDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.url().max(2048).refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    // URLSearchParams decodes names before credential aliases are checked.
    const secretQuery = [...url.searchParams.keys()].some(key => /^(key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|authorization|auth|password|secret|token)$/i.test(key));
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !secretQuery;
});
const origin = httpsUrl.refine(value => URL.canParse(value) && new URL(value).origin === value);
const assetPath = z.string().max(240).regex(/^io\.github\.ainsep\.openmarketing\/assets\/[A-Za-z0-9_-]+\.(svg|png|html|json)$/);
const field = z.strictObject({ name, label: text, hint: text.optional(), required: z.boolean().optional(), type: z.enum(['string', 'integer']).default('string') });
const secretField = field.omit({ type: true });
const cardSchema = z.strictObject({
    target: idSchema, title: text, label: text, category: text, intro: text,
    usedFor: z.array(z.string().min(1).max(120)).max(8), keyHint: text.optional(),
    helpUrl: httpsUrl, helpLabel: text, baseUrl: origin, probeUrl: httpsUrl.optional(),
    additionalHosts: z.array(origin).max(8).optional(), fields: z.array(field).max(16).optional(),
    secretFields: z.array(secretField).max(16).optional(),
    saveKind: z.enum(['oauth', 'oauth-client', 'api-key', 'developer-token', 'app-credentials']),
    saveTarget: idSchema.optional(), permissions: z.array(z.string().min(1).max(120)).max(16).optional(), icon: assetPath.optional(),
}).superRefine((card, ctx) => {
    const fields = [...(card.fields ?? []), ...(card.secretFields ?? [])];
    if (fields.length > 16 || new Set(fields.map(entry => entry.name)).size !== fields.length) ctx.addIssue({ code: 'custom', message: 'Invalid fields' });
    if (card.probeUrl && URL.canParse(card.probeUrl) && new URL(card.probeUrl).origin !== card.baseUrl) ctx.addIssue({ code: 'custom', message: 'Invalid probe origin' });
    if (['api-key', 'developer-token'].includes(card.saveKind) && (fields.length !== 1 || fields[0].name !== 'token' || !card.secretFields?.[0]?.required)) ctx.addIssue({ code: 'custom', message: 'Token requires a password field' });
});
export const credentialCardSchema = cardSchema.safeExtend({ pluginId: idSchema, actionSupported: z.boolean(), iconDigest: credentialDigestSchema.optional() });
export type CredentialCard = z.infer<typeof credentialCardSchema>;
export type CredentialCardManifest = { pluginId: string; credentialCards: CredentialCard[]; credentialAssets: Record<string, string> };
export const credentialPluginStatusSchema = z.strictObject({
    configured: z.boolean(), clientId: z.string().min(1).max(2048).optional(), guidance: text.optional(),
    credentialCards: z.array(credentialCardSchema).max(32), connections: z.array(integrationSummarySchema).max(100),
    connectionsCursor: idSchema.nullable(),
});
const extensionSchema = z.object({ credentialCards: z.array(cardSchema).max(32).default([]),
    credentialAssets: z.record(assetPath, credentialDigestSchema).refine(value => Object.keys(value).length <= 96).default({}) });
const manifestSchema = z.object({ name: idSchema, extensions: z.record(z.string(), z.unknown()).optional() });

/** Parse one installed package, binding every save target to its identity. Errors contain no input.
 * @example parseCredentialCardManifest({ raw: manifestText, pluginId: 'tiktok-ads' });
 * @complexity O(b + cards + fields) time/space; b <=64 KiB, <=32 cards and <=16 fields/card.
 */
export function parseCredentialCardManifest(required: { raw: string; pluginId: string }): Outcome<CredentialCardManifest> {
    try {
        if (Buffer.byteLength(required.raw) > 65536) return cardFailure({});
        const manifest = manifestSchema.parse(JSON.parse(required.raw));
        if (manifest.name !== required.pluginId) return cardFailure({});
        const data = extensionSchema.parse(manifest.extensions?.['io.github.ainsep.openmarketing'] ?? {});
        if (new Set(data.credentialCards.map(card => card.target)).size !== data.credentialCards.length) return cardFailure({});
        if (data.credentialCards.some(card => card.saveTarget && card.saveTarget !== manifest.name)) return cardFailure({});
        const credentialCards = data.credentialCards.map(card => {
            const { icon, ...metadata } = card;
            return { ...metadata, pluginId: manifest.name, saveTarget: manifest.name, actionSupported: credentialCardAction({ pluginId: manifest.name, saveKind: card.saveKind }),
                ...(icon && data.credentialAssets[icon] ? { icon, iconDigest: data.credentialAssets[icon] } : {}) };
        });
        return { ok: true, value: { pluginId: manifest.name, credentialCards, credentialAssets: data.credentialAssets } };
    } catch { return cardFailure({}); }
}

/** Only already-wired save flows are offered; declarations cannot install an auth provider. */
function credentialCardAction(required: { pluginId: string; saveKind: CredentialCard['saveKind'] }): boolean {
    switch (required.saveKind) {
        case 'api-key': case 'app-credentials': return true;
        case 'oauth': case 'oauth-client': return ['google-ads', 'linkedin-ads', 'meta-ads'].includes(required.pluginId);
        case 'developer-token': return required.pluginId === 'google-ads';
        default: { const exhaustive: never = required.saveKind; return exhaustive; }
    }
}

/** Validate icon bytes after a bounded reader. Digest checks corruption, never plugin admission.
 * @example credentialIcon({ path, digest, bytes });
 * @complexity O(b) time/space, b <=256 KiB. No filesystem or vendor effects.
 */
export function credentialIcon(required: { path: string; digest: string; bytes: Uint8Array }): Outcome<{ bytes: Uint8Array; contentType: 'image/svg+xml' | 'image/png' }> {
    if (required.bytes.byteLength > 262144 || createHash('sha256').update(required.bytes).digest('hex') !== required.digest) return cardFailure({});
    if (required.path.endsWith('.svg')) return { ok: true, value: { bytes: required.bytes, contentType: 'image/svg+xml' } };
    if (required.path.endsWith('.png') && Buffer.from(required.bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ok: true, value: { bytes: required.bytes, contentType: 'image/png' } };
    return cardFailure({});
}

/** Fixed boundary diagnostic never reflects manifest content, paths or credential values. */
function cardFailure(_required: Record<string, never>): { ok: false; error: { code: 'invalid_input'; message: string; retryable: false } } {
    return { ok: false, error: { code: 'invalid_input', message: 'Invalid credential card or asset', retryable: false } };
}
