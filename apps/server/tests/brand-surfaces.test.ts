/** Written-only brand product-surface regressions; no vendor calls or real storage. */
import { expect, it } from 'vitest';
import { createMemoryBrandRepo, brandKitSchema } from '@open-marketing/brand';
import { createMemoryCampaignRepo } from '@open-marketing/campaigns';
import { createMemoryConfirmationExchange, createMemorySafetyRepo } from '@open-marketing/safety';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { buildOmToolDefinitions, createOmTools } from '../src/om-tools.js';
import type { OmFeatureServices } from '../src/om-tools.js';
import type { OwnerServices } from '../src/inbound/owner.js';

const owner: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const agent: CallContext = { ...owner, runId: 'run', principal: { kind: 'agent', runId: 'run', agentInstanceId: 'instance' } };
const kit = brandKitSchema.parse({ business: { name: 'Fixture studio', facts: ['Owner-operated'] }, offers: [{ name: 'Consultation', facts: ['Thirty minutes'] }],
    audience: { pains: [], goals: [] }, voice: { use: ['Plain language'], avoid: [] }, colours: [], fonts: [], logoAssetIds: [], assetIds: [], prohibitedClaims: ['Guaranteed results'] });

function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error(required.result.error.message);
    return required.result.value;
}
/** Real catalog/dispatcher with the existing public in-memory adapters and owner answer seam. */
function fixture() {
    let sequence = 0;
    const clock = { now: () => 1000 }; const ids = { next: () => 'brand-' + ++sequence };
    const confirmations = createMemoryConfirmationExchange({ clock, ids, async recordAnswer() { return { ok: true as const, value: undefined }; } });
    const services: OwnerServices & OmFeatureServices = { campaigns: createMemoryCampaignRepo({}), safety: createMemorySafetyRepo({ clock, ids, ownerTimezone: 'UTC' }),
        confirmations, brand: { repo: createMemoryBrandRepo({}), clock } };
    const tools = createOmTools({ clock, observer: { observe() {} }, confirmations, authorize: () => ({ ok: true, value: undefined }),
        definitions: input => buildOmToolDefinitions({ ...input, services }) });
    const answer = async (input: { operationId: string }) => {
        const card = value({ result: await tools.card({ context: owner, ...input }) });
        if (!card) throw new Error('Expected brand approval');
        return tools.answer({ context: owner, approver: { kind: 'local_token', ownerId: 'owner', deviceId: 'fixture-device', tokenId: 'fixture-reference' },
            response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } });
    };
    return { services, tools, answer };
}

it('binds exactly four brand definitions with read/write policy and owner-only confirmation; omitted service advertises none', async () => {
    const f = fixture();
    try {
        const definitions = value({ result: await buildOmToolDefinitions({ context: agent, services: f.services }) });
        expect(definitions.filter(tool => tool.name.startsWith('om_brand_')).map(tool => ({ name: tool.name, policy: tool.policy, effects: tool.effects, ownerOnly: tool.ownerOnly === true })))
            .toEqual([
                { name: 'om_brand_get', policy: 'read', effects: ['read'], ownerOnly: false },
                { name: 'om_brand_confirmed', policy: 'read', effects: ['read'], ownerOnly: false },
                { name: 'om_brand_save_draft', policy: 'write', effects: ['write'], ownerOnly: false },
                { name: 'om_brand_confirm', policy: 'write', effects: ['write'], ownerOnly: true },
            ]);
        const { brand: _brand, ...services } = f.services;
        expect(value({ result: await buildOmToolDefinitions({ context: agent, services }) }).filter(tool => tool.name.startsWith('om_brand_'))).toEqual([]);
    } finally { await f.tools.dispose({}); }
});

it('saves through dispatch and owner approval, exposing a draft while confirmed facts stay null', async () => {
    const f = fixture();
    try {
        expect(await f.tools.dispatch({ context: owner, call: { name: 'om_brand_save_draft', input: { kit, expectedRevision: 0 }, operationId: 'save' } }))
            .toMatchObject({ ok: true, value: { status: 'pending' } });
        expect(await f.answer({ operationId: 'save' })).toEqual({ ok: true, value: undefined });
        expect(await f.tools.dispatch({ context: agent, call: { name: 'om_brand_get', input: {}, operationId: 'get' } }))
            .toMatchObject({ ok: true, value: { status: 'completed', output: { revision: 1, status: 'draft', kit } } });
        expect(await f.tools.dispatch({ context: agent, call: { name: 'om_brand_confirmed', input: {}, operationId: 'confirmed' } }))
            .toEqual({ ok: true, value: { status: 'completed', output: null } });
    } finally { await f.tools.dispose({}); }
});

it('an agent confirmation waits for a fresh owner card and records the answering owner as actor', async () => {
    const f = fixture();
    try {
        value({ result: await f.tools.dispatch({ context: agent, call: { name: 'om_brand_save_draft', input: { kit, expectedRevision: 0 }, operationId: 'save' } }) });
        value({ result: await f.answer({ operationId: 'save' }) });
        expect(await f.tools.dispatch({ context: agent, call: { name: 'om_brand_confirm', input: { revision: 1 }, operationId: 'confirm' } }))
            .toMatchObject({ ok: true, value: { status: 'pending', cardId: expect.any(String) } });
        expect(value({ result: await f.tools.card({ context: owner, operationId: 'confirm' }) })).toMatchObject({ allowedChoices: ['allow', 'cancel'] });
        value({ result: await f.answer({ operationId: 'confirm' }) });
        const confirmed = { revision: 2, status: 'confirmed', actor: { kind: 'owner', ownerId: 'owner' }, kit };
        expect(await f.tools.operation({ context: owner, operationId: 'confirm' })).toMatchObject({ ok: true, value: { status: 'completed', output: confirmed } });
        expect(await f.tools.dispatch({ context: agent, call: { name: 'om_brand_confirmed', input: {}, operationId: 'read-confirmed' } }))
            .toMatchObject({ ok: true, value: { status: 'completed', output: confirmed } });
    } finally { await f.tools.dispose({}); }
});

it('rejects an aggregate kit over 60 KiB at parse, counting UTF-8 bytes rather than characters', async () => {
    const f = fixture();
    try {
        const oversized = { ...kit, business: { ...kit.business, facts: Array.from({ length: 31 }, () => '界'.repeat(700)) } };
        expect(brandKitSchema.safeParse(oversized).success).toBe(true);
        expect(JSON.stringify(oversized).length).toBeLessThan(60 * 1024);
        const definitions = value({ result: await buildOmToolDefinitions({ context: owner, services: f.services }) });
        expect(definitions.find(tool => tool.name === 'om_brand_save_draft')!.parse({ input: { kit: oversized, expectedRevision: 0 } }))
            .toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally { await f.tools.dispose({}); }
});
