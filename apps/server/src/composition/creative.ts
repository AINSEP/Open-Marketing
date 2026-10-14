/** Durable creative lifecycle with explicitly zero-cost local quote/status fixtures. No vendor I/O. */
import { createHash } from 'node:crypto';
import { generationCostQuoteSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, GenerationCostQuote, IdPort, ObserverPort, Outcome, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { createCreativeService, createSqlCreativeRepo, createTransactionalCreativeJob, createMemoryGenerationCapability, createMemoryCreativeAsset, digestGenerationRequest } from '@open-marketing/creative';
import type { CreativeSqlDatabase, CreativeSqlSession, GenerationRequest, CreativeSpendPort } from '@open-marketing/creative';
import { createSafetyService, createMemoryAccountDispatchLock, digestArguments } from '@open-marketing/safety';
import type { EffectRequest, SafetyRepoPort, MemoryConfirmationExchange, VerifiedEffectResolverPort } from '@open-marketing/safety';
import type { AuditService } from '@open-marketing/audit';
import { createSqlJobRepo } from '@open-marketing/jobs';
import { creativeToolInputSchema } from '../om-tool-types.js';
import type { CreativeToolBinding, CreativeToolInput } from '../om-tool-types.js';
import { catalogAuditPort } from './catalog.js';
import { jobsDatabase, formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';

const fixtureDigest = createHash('sha256').update('om.sandbox.generation.v1').digest('hex');
/** Preserve caller deadlines so repeated preparation has identical quote/configuration evidence. */
function requestFor(required: { input: CreativeToolInput; operationId: string; approvalId?: string }): Outcome<GenerationRequest> {
    const request = { ...required.input, operationId: required.operationId, capabilityId: 'sandbox-generation', configurationDigest: fixtureDigest,
        seed: null, maxAttempts: 1, parameters: {}, vendorTermsDigest: null, ...(required.approvalId ? { approvalId: required.approvalId } : {}) };
    const digest = digestGenerationRequest({ request });
    return digest.ok ? { ok: true, value: { ...request, argumentsDigest: digest.value } } : digest;
}
/** Server-owned zero USD quote in contract field order, including nested money values.
 * Safety parses this shape before checking exact provenance. @complexity O(1), no I/O. */
function fixtureQuote(required: { argumentsDigest: string; deadlineAt: number; operationId: string }): GenerationCostQuote {
    return generationCostQuoteSchema.parse({ quoteId: 'sandbox:' + required.operationId, pluginId: 'om-sandbox', pluginDigest: fixtureDigest,
        modelConfigurationDigest: fixtureDigest, argumentsDigest: required.argumentsDigest, estimated: { currency: 'USD', minorUnits: 0 },
        upperBound: { currency: 'USD', minorUnits: 0 }, pricingEvidenceId: 'sandbox-zero-cost-v1', expiresAt: required.deadlineAt, status: 'known' });
}
/** Bind the exact tool envelope to the same reviewed generation inputs and fixture quote.
 * @complexity O(input bytes) bounded digest, no I/O. */
function effectFor(required: { input: CreativeToolInput; operationId: string }): Outcome<EffectRequest> {
    const args = { tool: 'om_creative_generate', input: required.input };
    const digest = digestArguments({ arguments: args });
    if (!digest.ok) return digest;
    return { ok: true, value: { arguments: args, pluginDigest: fixtureDigest, schemaFingerprint: fixtureDigest, operationScope: 'om_creative_generate',
        envelope: { operationId: required.operationId, connectionId: 'sandbox-generation', accountId: null, effects: ['generation'], argumentsDigest: digest.value, moneyExposure: null, requiredLimit: null },
        generation: { request: { operationId: required.operationId, connectionId: 'sandbox-generation', argumentsDigest: digest.value, configurationDigest: fixtureDigest },
            quote: fixtureQuote({ argumentsDigest: digest.value, deadlineAt: required.input.deadlineAt, operationId: required.operationId }) } } };
}
/** Map the existing '?' creative SQL ABI to the kernel's portable numbered parameters. */
function creativeSession(required: { session: SqlSession }): CreativeSqlSession {
    return { async query(input) { return (await required.session.query(sqlInput(input))).rows; },
        async execute(input) { return { changes: (await required.session.query(sqlInput(input))).rowCount ?? 0 }; } };
}
function sqlInput(required: { sql: string; parameters: readonly (string | number | null)[] }) {
    let index = 0;
    return { text: required.sql.replace(/\?/g, () => '$' + ++index), values: [...required.parameters] };
}
/** A failed outcome throws through the existing transaction owner to roll back all participants. */
class CreativeRollback extends Error {
    readonly outcome: Outcome<never>;
    constructor(required: { outcome: Outcome<never> }) { super('Creative transaction rejected'); this.outcome = required.outcome; }
}
async function atomic<T>(required: { unit: UnitOfWork; work: (required: { session: SqlSession }) => Promise<Outcome<T>> }): Promise<Outcome<T>> {
    try { return await required.unit.transaction({ work: async input => {
        const result = await required.work(input);
        if (!result.ok) throw new CreativeRollback({ outcome: result });
        return result;
    } }); } catch (error) { return error instanceof CreativeRollback ? error.outcome : localFailure({ message: 'Creative transaction unavailable' }); }
}
/** Creative and jobs adapters join the same transaction; no new DB or outbox is constructed. */
function creativeDatabase(required: { unit: UnitOfWork }): CreativeSqlDatabase {
    return { transaction: ({ run }) => atomic({ unit: required.unit, work: ({ session }) => run({ session: creativeSession({ session }) }) }) };
}
/** Fixed generation-only resolver binds the request deadline and checks expiry against the
 * injected clock on assessment/dispatch. Expiry and provenance failures return typed errors.
 * @complexity O(n) bounded effect bytes/space; no I/O beyond the injected clock. */
function fixtureResolver(required: { clock: ClockPort }): VerifiedEffectResolverPort {
    return { async resolve({ request }) {
        const input = creativeToolInputSchema.safeParse(request.arguments.input);
        if (!input.success || request.arguments.tool !== 'om_creative_generate') return localFailure({ code: 'forbidden', message: 'Unknown sandbox effect' });
        const expected = effectFor({ input: input.data, operationId: request.envelope.operationId });
        if (!expected.ok) return expected;
        const actualDigest = digestArguments({ arguments: request });
        const expectedDigest = digestArguments({ arguments: expected.value });
        if (!actualDigest.ok || !expectedDigest.ok || actualDigest.value !== expectedDigest.value) return localFailure({ code: 'forbidden', message: 'Sandbox effect differs from verified binding' });
        return { ok: true, value: expected.value.envelope };
    }, async verifyGenerationQuote({ request, quote }) {
        const now = required.clock.now({});
        const { expiresAt, ...priceEvidence } = quote;
        if (expiresAt <= now) return localFailure({ code: 'expired', message: 'Sandbox pricing evidence expired' });
        // resolve() binds the exact request deadline; assessment has only the frozen request key.
        const { expiresAt: _expiryThreshold, ...expectedEvidence } = fixtureQuote({ argumentsDigest: request.argumentsDigest, deadlineAt: now, operationId: request.operationId });
        if (request.connectionId !== 'sandbox-generation' || request.configurationDigest !== fixtureDigest || JSON.stringify(expectedEvidence) !== JSON.stringify(priceEvidence)) return localFailure({ code: 'forbidden', message: 'Invalid sandbox price provenance' });
        return { ok: true, value: undefined };
    }, async verifyHaltStop() { return localFailure({ code: 'forbidden', message: 'Typed remote stop is not bound' }); } };
}
/** Real service/repo/outbox with inert fixture backend. requestGeneration queues durable intent;
 * status/cancel work before dispatch. Vendor generation/worker admission remains I-2.
 * @complexity O(1) construction; bounded owning service operations, no vendor requests. */
export function bindSandboxCreative(required: { unit: UnitOfWork; safetyRepo: SafetyRepoPort; confirmations: MemoryConfirmationExchange; clock: ClockPort; ids: IdPort; observer: ObserverPort; audit: AuditService }): CreativeToolBinding {
    const repo = createSqlCreativeRepo({ database: creativeDatabase(required) });
    const audit = catalogAuditPort(required);
    const safety = createSafetyService({ repo: required.safetyRepo, confirmations: required.confirmations, clock: required.clock, ids: required.ids, audit,
        effects: fixtureResolver({ clock: required.clock }), accountLocks: createMemoryAccountDispatchLock({ ids: required.ids }),
        policy: { async assess({ envelope }) { return { ok: true, value: { allowed: envelope.connectionId === 'sandbox-generation' && envelope.accountId === null && envelope.effects.every(effect => effect === 'generation') } }; } },
        platformLimits: { async get() { return localFailure({ code: 'forbidden', message: 'Sandbox generation has no ad platform authority' }); } },
    }, { observer: required.observer });
    const backend = createMemoryGenerationCapability({ repo });
    const generation = { ...backend, async quote({ request }: { context: CallContext; request: GenerationRequest }) {
        if (request.model !== 'sandbox' || request.capabilityId !== 'sandbox-generation') return localFailure<GenerationCostQuote>({ code: 'unavailable', message: 'I-2: install a generation backend; local model is sandbox' });
        return { ok: true as const, value: fixtureQuote({ argumentsDigest: request.argumentsDigest, deadlineAt: request.deadlineAt, operationId: request.operationId }) };
    } };
    const spend: CreativeSpendPort = { async assess({ context, request }) {
        const effect = effectFor({ input: creativeInput(request), operationId: request.operationId });
        return effect.ok ? safety.assessGeneration({ context, ...effect.value.generation! }) : effect;
    }, async withDispatch({ context, request, dispatch }) {
        const effect = effectFor({ input: creativeInput(request), operationId: request.operationId });
        if (!effect.ok) return effect;
        if (!request.approvalId) return localFailure({ code: 'forbidden', message: 'Generation lacks exact recorded authority' });
        return safety.withDispatch({ context, request: { ...effect.value, approvalId: request.approvalId, policyRevision: 0 }, dispatch: ({ permit }) => dispatch({ reservationId: permit.reservationId }) });
    }, settle({ context, reservationId, cost }) {
        return required.safetyRepo.settleGeneration({ context, settlement: { reservationId, observationId: cost.observationId, actual: cost.amount,
            ...(cost.correctionOf ? { correctsObservationId: cost.correctionOf } : {}) } });
    } };
    const jobs = createTransactionalCreativeJob({ transaction: input => atomic({ unit: required.unit, work: ({ session }) => input.run({
        repo: createSqlCreativeRepo({ database: { transaction: ({ run }) => run({ session: creativeSession({ session }) }) } }),
        enqueue: async request => {
            const joined = createSqlJobRepo({ database: jobsDatabase({ unit: session }), clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
            const result = await joined.enqueue({ context: request.context, job: { handler: 'creative.generate', operationId: request.operationId, idempotencyKey: 'creative:' + request.operationId,
                argumentsDigest: request.argumentsDigest, payload: { generationId: request.generationId } } });
            return result.ok ? { ok: true, value: { jobId: result.value.jobId } } : result;
        },
    }) }) });
    const service = createCreativeService({ repo, generation, jobs, safety: spend, assets: createMemoryCreativeAsset({}), clock: required.clock, ids: required.ids, audit }, { observer: required.observer });
    return { service, safety, async dispatchQueued(input) {
        const current = await repo.get(input);
        if (!current.ok) return current;
        if (current.value.request.argumentsDigest !== input.argumentsDigest || current.value.request.operationId !== input.operationId || input.generationId !== input.operationId) return localFailure({ code: 'conflict', message: 'Creative job differs from its committed intent' });
        return service.dispatchGeneration(input);
    }, async prepareEffect({ call }) {
        const input = creativeToolInputSchema.safeParse(call.input);
        if (!input.success) return localFailure({ code: 'invalid_input', message: 'Invalid sandbox generation input' });
        if (input.data.deadlineAt <= required.clock.now({}) || input.data.deadlineAt - required.clock.now({}) > 86400000) return localFailure({ code: 'invalid_input', message: 'Generation deadline must be within the next day' });
        return effectFor({ input: input.data, operationId: call.operationId });
    }, async generate({ context, input, authorization, permit }) {
        if (permit.operationId !== authorization.envelope.operationId || permit.argumentsDigest !== authorization.envelope.argumentsDigest) return localFailure({ code: 'forbidden', message: 'Generation permit mismatch' });
        const request = requestFor({ input, operationId: authorization.envelope.operationId, approvalId: authorization.approvalId });
        return request.ok ? service.requestGeneration({ context, request: request.value }) : request;
    } };
}
/** Select only original reviewed fields when reconstructing the financial tool envelope. */
function creativeInput(required: GenerationRequest): CreativeToolInput {
    return creativeToolInputSchema.parse({ prompt: required.prompt, surface: required.surface, model: required.model, rightsEvidenceId: required.rightsEvidenceId, deadlineAt: required.deadlineAt });
}
