/** Owner-managed conversion-sharing authority. Delivery remains a separate typed worker. */
import { z } from 'zod';
import { callContextSchema, idSchema, measurementGrantSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, CallOptions, ClockPort, IdPort, MeasurementGrant, ObserverPort, Outcome } from '@open-marketing/contracts';
import { createSqlMeasurementGrant, createSqlMeasureAudit } from '@open-marketing/measure';
import type { MeasureSqlDatabase } from '@open-marketing/measure';
import { localFailure } from './local-auth.js';

/** Fixed payload identity accepted by measure's conversion dispatcher. */
export const CONVERSION_PAYLOAD_SCHEMA = 'om.conversion';
/** Caller-owned identity makes retries idempotent; authority and payload metadata are server-owned. */
export const grantFieldsSchema = measurementGrantSchema.omit({ scope: true, kind: true, revoked: true, payloadSchema: true, payloadVersion: true });
const grantInputSchema = z.strictObject({ context: callContextSchema, grant: grantFieldsSchema });
const revokeInputSchema = z.strictObject({ context: callContextSchema, grantId: idSchema });
type Dependencies = { database: MeasureSqlDatabase; clock: ClockPort; ids: IdPort; observer: ObserverPort };

/** Bind SQL authority to owner continuations from the existing exact-card dispatcher.
 * Grant/revoke and their audit record commit together; audit failure rolls back the mutation.
 * @example bindMeasurementGrants({ database, clock, ids, observer }).grant({ context, grant });
 * @complexity O(1) construction; indexed constant-query writes, lists decode <=101 grants.
 */
export function bindMeasurementGrants(required: Dependencies) {
    const store = createSqlMeasurementGrant(required, { observer: required.observer });
    return {
        list: store.list,
        async grant(input: z.infer<typeof grantInputSchema>, options?: CallOptions): Promise<Outcome<MeasurementGrant>> {
            const parsed = parseBoundary({ schema: grantInputSchema, input });
            if (!parsed.ok) return parsed;
            const { context, grant } = parsed.value;
            return changeGrant({ ...required, context, grantId: grant.grantId, grant: { ...grant, scope: context.scope,
                kind: 'measurement', revoked: false, payloadSchema: CONVERSION_PAYLOAD_SCHEMA, payloadVersion: 1 } }, options);
        },
        async revoke(input: z.infer<typeof revokeInputSchema>, options?: CallOptions): Promise<Outcome<MeasurementGrant>> {
            const parsed = parseBoundary({ schema: revokeInputSchema, input });
            if (!parsed.ok) return parsed;
            return changeGrant({ ...required, ...parsed.value }, options);
        },
    };
}

/** Both mutations join the same session as their audit. Throws leave only after rollback;
 * driver/audit exceptions are sanitized and never imply permission or a retry.
 * @complexity Fixed indexed SQL calls and bounded grant parsing; no external egress.
 */
async function changeGrant(required: Dependencies & { context: CallContext; grantId: string; grant?: MeasurementGrant }, optional?: CallOptions): Promise<Outcome<MeasurementGrant>> {
    if (required.context.principal.kind !== 'owner') return localFailure({ code: 'forbidden', message: 'Only the owner can change measurement grants' });
    try {
        return await required.database.transaction({ work: async ({ session }) => {
            const dependencies = { ...required, database: session };
            const store = createSqlMeasurementGrant(dependencies, { observer: required.observer });
            const result = required.grant ? await store.grant({ context: required.context, grant: required.grant }, optional)
                : await store.revoke({ context: required.context, grantId: required.grantId }, optional);
            if (!result.ok) return result;
            if (required.grant && result.value.revoked) return localFailure({ code: 'conflict', message: 'Measurement grant was revoked' });
            const recorded = await createSqlMeasureAudit(dependencies, { observer: required.observer }).record({ context: required.context,
                operationId: required.grantId, outcome: required.grant ? 'grant_created' : 'grant_revoked' }, optional);
            if (!recorded.ok) throw new Error('Measurement grant audit failed');
            return result;
        } });
    } catch { return localFailure({ code: 'unavailable', message: 'Measurement grant change could not be confirmed' }); }
}
