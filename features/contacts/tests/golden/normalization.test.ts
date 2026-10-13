/** Executable specification for the later contacts implementation. Stubs intentionally do not pass.
 * Expected strings/hashes are fixed data; tests never derive expected values from the implementation. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CountryCode } from 'libphonenumber-js';
import type { Outcome } from '@open-marketing/contracts';
import { destinationIdentifierHash, normalizeEmail, normalizePhoneE164, toMetaFbc } from '../../index.js';

type Fixture = { id: string; normalized?: string; sha256?: string; error?: 'invalid_input' } & (
    { kind: 'email'; raw: string } | { kind: 'phone'; raw: string; country?: CountryCode } | { kind: 'fbc'; fbclid: string; clickTimeMs: number }
);
const fixtures = JSON.parse(readFileSync(new URL('./normalization.json', import.meta.url), 'utf8')) as Fixture[];

/** Invoke only the public normalizers. Phone defaults require explicit region for national numbers. */
function normalize({ fixture }: { fixture: Fixture }): Outcome<string> {
    switch (fixture.kind) {
        case 'email': return normalizeEmail({ raw: fixture.raw });
        case 'phone': return normalizePhoneE164({ raw: fixture.raw }, { country: fixture.country });
        case 'fbc': return toMetaFbc({ fbclid: fixture.fbclid, clickTimeMs: fixture.clickTimeMs });
        default: { const exhaustive: never = fixture; throw new TypeError(String(exhaustive)); }
    }
}

describe('frozen normalization and destination SHA-256 golden cases', () => {
    it.each(fixtures)('$id', fixture => {
        const result = normalize({ fixture });
        if (fixture.error) {
            expect(result).toMatchObject({ ok: false, error: { code: fixture.error } });
            return;
        }
        expect(result).toEqual({ ok: true, value: fixture.normalized });
        if (!result.ok) throw new Error('Expected normalized identifier');
        if (fixture.sha256) expect(destinationIdentifierHash({ normalizedValue: result.value })).toEqual({ ok: true, value: fixture.sha256 });
    });
});
