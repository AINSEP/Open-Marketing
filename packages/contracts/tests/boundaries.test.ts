import { it, expect } from 'vitest';
import { haltStopRequestSchema, measurementGrantSchema, navigationResultSchema, DEFAULT_GENERATION_ALLOWANCE, parseBoundary } from '../src/index.js';
import { approverRefSchema, dispatchDecisionSchema, encodeCampaignKey, parseCampaignKey } from '../src/index.js';
it('halt-stop schema rejects activation, arbitrary arguments and budget inflation', () => {
 const request = { operationId: 'op', scope: { ownerId: 'o', workspaceId: 'w' }, connectionId: 'c', adAccountId: 'a', entityIds: ['existing'], action: 'stop', haltId: 'h', haltEpoch: 1, pluginDigest: 'a'.repeat(64), bindingId: 'b', argumentsDigest: 'b'.repeat(64) };
 expect(haltStopRequestSchema.safeParse(request).success).toBe(true);
 for (const invalid of [{ ...request, action: 'activate' },{ ...request, budget: 5 }, { ...request, arguments: { action: 'activate' } }]) expect(haltStopRequestSchema.safeParse(invalid).success).toBe(false);
});
it('campaign keys round-trip colon/Unicode identifiers and reject noncanonical or oversized encodings', () => {
 const key = { pluginId: 'ads', accountId: 'acct:一', vendorCampaignId: 'urn:li:campaign:123' };
 const encoded = encodeCampaignKey({ key });
 expect(encoded.ok).toBe(true);
 if (!encoded.ok) throw new Error('Expected key encoding');
 expect(encoded.value).toMatch(/^ck1:[A-Za-z0-9_-]+$/);
 expect(parseCampaignKey({ value: encoded.value })).toEqual({ ok: true, value: key });
 expect(encodeCampaignKey({ key: { ...key, pluginId: '' } }).ok).toBe(false);
 expect(encodeCampaignKey({ key: { ...key, vendorCampaignId: '界'.repeat(100) } }).ok).toBe(false);
 const atLimit = encodeCampaignKey({ key: { pluginId: 'a', accountId: 'b', vendorCampaignId: 'c'.repeat(177) } });
 expect(atLimit.ok && atLimit.value.length).toBe(256);
 expect(atLimit.ok && parseCampaignKey({ value: atLimit.value }).ok).toBe(true);
 expect(encodeCampaignKey({ key: { pluginId: 'a', accountId: 'b', vendorCampaignId: 'c'.repeat(178) } }).ok).toBe(false);
 const raw = (json: string) => 'ck1:' + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 for (const value of [null, 1, '', 'ck2:x', 'ck1:a', 'ck1:_w', 'ck1:____', 'ck1:' + 'a'.repeat(253), encoded.value + '=', raw('not-json'), raw('["a", "b", "c"]'),
   raw('["a","b","c","extra"]'), raw('{"pluginId":"a"}'), raw('["a","b",1]'), raw('["","b","c"]'), 'ck1:WyJhIiwiYiIsImMiXR'])
   expect(parseCampaignKey({ value }).ok).toBe(false);
 expect(parseCampaignKey({ value: 'ck1:WyJhIiwiYiIsImMiXQ' })).toEqual({ ok: true, value: { pluginId: 'a', accountId: 'b', vendorCampaignId: 'c' } });
});
it('actor references are secret-free and barrier decisions carry no permit or denial taxonomy', () => {
 for (const actor of [{ kind: 'jini_user', userId: 'u' }, { kind: 'local_token', ownerId: 'o', deviceId: 'd', tokenId: 'reference' }])
   expect(approverRefSchema.safeParse(actor).success).toBe(true);
 for (const actor of [{ kind: 'agent', runId: 'r' }, { kind: 'local_token', ownerId: 'o', tokenId: 't' }, { kind: 'jini_user', userId: 'u', token: 'secret' }])
   expect(approverRefSchema.safeParse(actor).success).toBe(false);
 expect(dispatchDecisionSchema.safeParse({ allowed: true }).success).toBe(true);
 expect(dispatchDecisionSchema.safeParse({ allowed: false, reason: 'consent_withdrawn' }).success).toBe(true);
 expect(dispatchDecisionSchema.safeParse({ allowed: false }).success).toBe(false);
 expect(dispatchDecisionSchema.safeParse({ allowed: true, permit: 'authority' }).success).toBe(false);
});
it('measurement authority has a closed scope and cannot become a tool grant', () => expect(measurementGrantSchema.safeParse({ kind: 'campaign', arbitraryTool: 'mutate' }).success).toBe(false));
it('default allowance is explicit USD $10/UTC and navigation success needs a completed browser result', () => {
 expect(DEFAULT_GENERATION_ALLOWANCE).toEqual({ amount: { minorUnits: 1000, currency: 'USD' }, dayTimezone: 'UTC', revision: 0 });
 expect(parseBoundary({ schema: navigationResultSchema, input: { status: 'completed', actionId: 'a' } }).ok).toBe(false);
});
