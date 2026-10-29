import { it, expect, vi } from 'vitest';
import { haltStopRequestSchema, measurementGrantSchema, navigationResultSchema, DEFAULT_GENERATION_ALLOWANCE, parseBoundary } from '../src/index.js';
import { approverRefSchema, dispatchDecisionSchema, encodeCampaignKey, parseCampaignKey, parseExactIntegerJson, serviceContextSchema } from '../src/index.js';
it('validates service contexts without principals, credentials or authority-bearing extras', () => {
 const input = { scope: { ownerId: 'o', workspaceId: 'w' }, serviceId: 'sync', correlationId: 'c', traceId: 't' };
 expect(serviceContextSchema.parse(input)).toEqual(input);
 for (const change of [{ serviceId: '' }, { traceId: '' }, { principal: { kind: 'owner', ownerId: 'o' } }, { approved: true }])
   expect(serviceContextSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
it('recovers unsafe positive/negative integer tokens and preserves selected exact decimal sources', () => {
 expect(parseExactIntegerJson({ text: '{"id":9007199254740993,"negative":-9007199254740993,"small":-1,"ordinary":1.0,"cost":0.1234567890123456789,"exponent":1e-7,"text":"9007199254740993","nested":[9007199254740995]}' }, { numericTextKeys: ['cost', 'exponent'] })).toEqual({ ok: true, value: {
   id: '9007199254740993', negative: '-9007199254740993', small: -1, ordinary: 1, cost: '0.1234567890123456789', exponent: '1e-7', text: '9007199254740993', nested: ['9007199254740995'],
 } });
 expect(parseExactIntegerJson({ text: '{"a":1,"b":1.0,"c":1e3}' }, { numericTextKeys: ['a', 'b', 'c'] })).toEqual({ ok: true, value: { a: '1', b: '1.0', c: '1e3' } });
 expect(parseExactIntegerJson({ text: '[-1,1.0,1e3,0.5,true,null,"x"]' })).toEqual({ ok: true, value: [-1, 1, 1000, 0.5, true, null, 'x'] });
});
it('rejects malformed, oversized and unrecoverable numeric JSON without inventing precision', () => {
 for (const text of ['{', '{"a":}', '9007199254740993.5', '1e999', '{"a":1,}', '0'.repeat(1048577)])
   expect(parseExactIntegerJson({ text }).ok).toBe(false);
 expect(parseExactIntegerJson({ text: '"' + '界'.repeat(350000) + '"' })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
 expect(parseExactIntegerJson({ text: ' '.repeat(1048575) + '0' })).toEqual({ ok: true, value: 0 });
 expect(parseExactIntegerJson({ text: '0' }, { numericTextKeys: Array(101).fill('a') }).ok).toBe(false);
});
it('fails closed without source context only when numeric precision evidence is needed', () => {
 const parse = JSON.parse;
 const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => parse(text, reviver ? (key, value) => reviver(key, value) : undefined));
 try {
   expect(parseExactIntegerJson({ text: '[-1,1.0,0.5]' })).toEqual({ ok: true, value: [-1, 1, 0.5] });
   expect(parseExactIntegerJson({ text: '9007199254740993' })).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
   expect(parseExactIntegerJson({ text: '{"cost":1.25}' }, { numericTextKeys: ['cost'] })).toMatchObject({ ok: false, error: { code: 'protocol_mismatch' } });
 } finally { spy.mockRestore(); }
});
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
 const raw = ({ json }: { json: string }) => 'ck1:' + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 for (const value of [null, 1, '', 'ck2:x', 'ck1:a', 'ck1:_w', 'ck1:____', 'ck1:' + 'a'.repeat(253), encoded.value + '=', raw({ json: 'not-json' }), raw({ json: '["a", "b", "c"]' }),
   raw({ json: '["a","b","c","extra"]' }), raw({ json: '{"pluginId":"a"}' }), raw({ json: '["a","b",1]' }), raw({ json: '["","b","c"]' }), 'ck1:WyJhIiwiYiIsImMiXR'])
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
it('measurement grant binds open definition IDs and rejects legacy event types', () => {
 const grant = { kind: 'measurement', grantId: 'g', scope: { ownerId: 'o', workspaceId: 'w' }, connectionId: 'c', accountId: 'a', definitionIds: ['qualified_lead'], destination: 'd', purpose: 'p', payloadSchema: 's', payloadVersion: 1, expiresAt: 1, revoked: false };
 expect(measurementGrantSchema.safeParse(grant).success).toBe(true);
 expect(measurementGrantSchema.safeParse({ ...grant, definitionIds: [] }).success).toBe(false);
 const { definitionIds: _definitionIds, ...legacy } = grant;
 expect(measurementGrantSchema.safeParse({ ...legacy, eventTypes: ['signup'] }).success).toBe(false);
});
it('default allowance is explicit USD $10/UTC and navigation success needs a completed browser result', () => {
 expect(DEFAULT_GENERATION_ALLOWANCE).toEqual({ amount: { minorUnits: 1000, currency: 'USD' }, dayTimezone: 'UTC', revision: 0 });
 expect(parseBoundary({ schema: navigationResultSchema, input: { status: 'completed', actionId: 'a' } }).ok).toBe(false);
});
