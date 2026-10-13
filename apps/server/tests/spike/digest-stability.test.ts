import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { digestArguments } from '@open-marketing/safety';

describe('A9: absent optional schema additions preserve existing exact approvals', () => {
    it('keeps the original public digest after an absent extension, and changes it when present', () => {
        const originalSchema = z.strictObject({ a: z.number().int(), b: z.number().int() });
        const extendedSchema = originalSchema.extend({ targeting: z.strictObject({ includeAudienceRefs: z.array(z.string()) }).optional() });
        // Existing public digest fixture from safety/tests/acceptance/boundary.test.ts.
        const fixture = { b: 2, a: 1 };
        const expected = { ok: true, value: '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' };
        const original = digestArguments({ arguments: originalSchema.parse(fixture) });
        const extended = extendedSchema.parse(fixture);
        expect(Object.hasOwn(extended, 'targeting')).toBe(false);
        expect(original).toEqual(expected);
        expect(digestArguments({ arguments: extended })).toEqual(expected);
        const present = digestArguments({ arguments: extendedSchema.parse({ ...fixture, targeting: { includeAudienceRefs: ['audience-fixture'] } }) });
        expect(present.ok).toBe(true);
        expect(present).not.toEqual(original);
    });
    it('continues rejecting explicit undefined as non-JSON', () => {
        expect(digestArguments({ arguments: { b: 2, a: 1, targeting: undefined } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    });
});
