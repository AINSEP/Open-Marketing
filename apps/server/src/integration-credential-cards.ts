/** Declarative metadata only; no declaration executes code or grants authority.
 * Host forms bind pluginId/saveTarget to the installed package, never a submitted field.
 * oauth -> existing policy-controlled start; oauth-client -> existing sealed client route.
 * api-key -> sealed token plaintext; app-credentials -> exact JSON of declared public/password
 * fields (integer fields stay numbers); plugin-secret -> declared sealed plugin fields.
 * Secret values travel directly to owner ingress, never tool arguments, status or logs.
 * Zod callbacks below use its fixed value/context ABI.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { cardSchema, conversionSettingsDeclarationSchema, digestSchema, idSchema } from '@open-marketing/contracts';
import type { ConversionSettingsDeclaration, CredentialCard, Outcome } from '@open-marketing/contracts';

const assetPath = cardSchema.shape.icon.unwrap();
export type CredentialCardManifest = { pluginId: string; credentialCards: CredentialCard[]; credentialAssets: Record<string, string>; conversionSettings?: ConversionSettingsDeclaration | null };
const extensionSchema = z.object({ credentialCards: z.array(cardSchema).max(32).default([]),
    credentialAssets: z.record(assetPath, digestSchema).refine(value => Object.keys(value).length <= 96).default({}) });
const manifestSchema = z.object({ name: idSchema, extensions: z.record(z.string(), z.unknown()).optional() });

/** Parse one installed package, binding every save target to its identity. Errors contain no input.
 * @example parseCredentialCardManifest({ raw: manifestText, pluginId: 'fixture-plugin' });
 * @complexity O(b + cards + fields) time/space; b <=64 KiB, <=32 cards and <=16 fields/card.
 */
export function parseCredentialCardManifest(required: { raw: string; pluginId: string }): Outcome<CredentialCardManifest> {
    try {
        if (Buffer.byteLength(required.raw) > 65536) return cardFailure({});
        const manifest = manifestSchema.parse(JSON.parse(required.raw));
        if (manifest.name !== required.pluginId) return cardFailure({});
        const extension = manifest.extensions?.['io.github.ainsep.openmarketing'] ?? {};
        const data = extensionSchema.parse(extension);
        // Conversion declarations cannot make otherwise usable credentials unavailable.
        const conversionSettings = conversionSettingsDeclarationSchema.safeParse(z.object({ conversionSettings: z.unknown().optional() }).parse(extension).conversionSettings);
        if (new Set(data.credentialCards.map(card => card.target)).size !== data.credentialCards.length) return cardFailure({});
        if (data.credentialCards.some(card => card.saveTarget && card.saveTarget !== manifest.name)) return cardFailure({});
        const credentialCards = data.credentialCards.map(card => {
            const { icon, ...metadata } = card;
            return { ...metadata, pluginId: manifest.name, saveTarget: manifest.name, actionSupported: credentialCardAction({ card, oauthRegistered: false }),
                ...(icon && data.credentialAssets[icon] ? { icon, iconDigest: data.credentialAssets[icon] } : {}) };
        });
        return { ok: true, value: { pluginId: manifest.name, credentialCards, credentialAssets: data.credentialAssets, conversionSettings: conversionSettings.success ? conversionSettings.data : null } };
    } catch { return cardFailure({}); }
}

/** Declarations select the existing ingress; OAuth also needs a registered provider.
 * No declaration grants authority. @complexity O(1) time/space; pure.
 * @example credentialCardAction({ card, oauthRegistered: providers.has(pluginId) });
 */
export function credentialCardAction(required: { card: z.infer<typeof cardSchema>; oauthRegistered: boolean }): boolean {
    switch (required.card.saveKind) {
        case 'api-key': case 'app-credentials': return true;
        case 'plugin-secret': return Boolean(required.card.secretFields?.length);
        case 'oauth': case 'oauth-client': return required.oauthRegistered;
        default: { const exhaustive: never = required.card.saveKind; return exhaustive; }
    }
}

/** Extra OAuth client keys come only from public oauth-client fields, never secretFields.
 * Shared by save, status and exchange. @complexity O(cards + fields), <=32 cards/16 fields each.
 * @example credentialOAuthClientFields({ cards: manifest.credentialCards });
 */
export function credentialOAuthClientFields(required: { cards: readonly CredentialCard[] }): readonly string[] {
    return [...new Set(required.cards.filter(card => card.saveKind === 'oauth-client').flatMap(card => card.fields ?? []).map(field => field.name).filter(name => name !== 'clientId'))];
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
