import { it, expect } from 'vitest';
import { haltStopRequestSchema, measurementGrantSchema, navigationResultSchema, DEFAULT_GENERATION_ALLOWANCE, parseBoundary } from '../src/index.js';
it('halt-stop schema rejects activation, arbitrary arguments and budget inflation', () => {
 const request = { operationId: 'op', scope: { ownerId: 'o', workspaceId: 'w' }, connectionId: 'c', adAccountId: 'a', entityIds: ['existing'], action: 'stop', haltId: 'h', haltEpoch: 1, pluginDigest: 'a'.repeat(64), bindingId: 'b', argumentsDigest: 'b'.repeat(64) };
 expect(haltStopRequestSchema.safeParse(request).success).toBe(true);
 for (const invalid of [{ ...request, action: 'activate' },{ ...request, budget: 5 }, { ...request, arguments: { action: 'activate' } }]) expect(haltStopRequestSchema.safeParse(invalid).success).toBe(false);
});
it('measurement authority has a closed scope and cannot become a tool grant', () => expect(measurementGrantSchema.safeParse({ kind: 'campaign', arbitraryTool: 'mutate' }).success).toBe(false));
it('default allowance is explicit USD $10/UTC and navigation success needs a completed browser result', () => {
 expect(DEFAULT_GENERATION_ALLOWANCE).toEqual({ amount: { minorUnits: 1000, currency: 'USD' }, dayTimezone: 'UTC', revision: 0 });
 expect(parseBoundary({ schema: navigationResultSchema, input: { status: 'completed', actionId: 'a' } }).ok).toBe(false);
});
