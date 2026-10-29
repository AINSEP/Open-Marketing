/** Written-only real-SQL regressions; no provider or live migration effects. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import type { CallContext } from '@open-marketing/contracts';
import { createSqlMeasurementGrant } from '@open-marketing/measure';
import { bindServerDatabase } from '../src/composition/database.js';
import { bindMeasurementGrants, CONVERSION_PAYLOAD_SCHEMA } from '../src/composition/conversions.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
const grant = { grantId: 'grant', connectionId: 'connection', accountId: 'account', destination: 'fixture-plugin',
    definitionIds: ['qualified'], purpose: 'measurement', expiresAt: 10000 };
const handles: Database.Database[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });

/** Owning kernel plus a trigger can fail only the audit insert after the authority write. */
function fixture() {
    const native = new Database(':memory:'); handles.push(native);
    for (const migration of ['0001_measure', '0002_attribution_account', '0003_metrics', '0004_metrics_membership', '0005_measurement_grants']) {
        native.exec(readFileSync(new URL('../../../features/measure/migrations/' + migration + '.sql', import.meta.url), 'utf8'));
    }
    let sequence = 0;
    const clock = { now: () => 1000 }, ids = { next: () => 'audit-' + ++sequence }, observer = { observe() {} };
    const database = bindServerDatabase({ native, context, observer }).workspace;
    return { native, service: bindMeasurementGrants({ database, clock, ids, observer }), store: createSqlMeasurementGrant({ database, clock }) };
}

it('lets the owner grant, list and revoke with fixed server metadata and owner audit evidence', async () => {
    const f = fixture();
    const stored = { ...grant, kind: 'measurement', scope: context.scope, revoked: false, payloadSchema: CONVERSION_PAYLOAD_SCHEMA, payloadVersion: 1 };
    expect(await f.service.grant({ context, grant })).toEqual({ ok: true, value: stored });
    expect(await f.service.list({ context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [stored], cursor: null } });
    expect(await f.service.revoke({ context, grantId: grant.grantId })).toEqual({ ok: true, value: { ...stored, revoked: true } });
    const serviceContext = { scope: context.scope, serviceId: 'conversion-worker', correlationId: context.correlationId, traceId: context.traceId };
    expect(await f.store.current({ context: serviceContext, grantId: grant.grantId })).toEqual({ ok: true, value: { ...stored, revoked: true } });
    const audit = f.native.prepare('SELECT operation_id,outcome,context_json FROM measure_egress_audit ORDER BY audit_id').all();
    expect(audit).toEqual(['grant_created', 'grant_revoked'].map(outcome => ({ operation_id: grant.grantId, outcome, context_json: JSON.stringify(context) })));
});

it('rejects non-owner grant/revoke and caller-supplied authority or payload metadata', async () => {
    const f = fixture();
    const agent: CallContext = { ...context, principal: { kind: 'agent', agentInstanceId: 'agent', runId: 'run' } };
    expect(await f.service.grant({ context: agent, grant })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await f.service.revoke({ context: agent, grantId: grant.grantId })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    for (const extra of [{ scope: { ownerId: 'foreign', workspaceId: 'foreign' } }, { payloadSchema: 'arbitrary' }, { payloadVersion: 2 }]) {
        expect(await f.service.grant({ context, grant: { ...grant, ...extra } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    }
    expect(await f.service.list({ context, query: { limit: 100 } })).toMatchObject({ ok: true, value: { items: [] } });
});

it('rolls back both grant and revoke when the required audit insert fails', async () => {
    const f = fixture();
    const failAudit = "CREATE TRIGGER fail_measure_audit BEFORE INSERT ON measure_egress_audit BEGIN SELECT RAISE(ABORT, 'private driver failure'); END";
    f.native.exec(failAudit);
    const failed = await f.service.grant({ context, grant });
    expect(failed).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(JSON.stringify(failed)).not.toContain('private driver failure');
    expect(f.native.prepare('SELECT * FROM measure_grant').all()).toEqual([]);
    f.native.exec('DROP TRIGGER fail_measure_audit');
    expect((await f.service.grant({ context, grant })).ok).toBe(true);
    f.native.exec(failAudit);
    expect(await f.service.revoke({ context, grantId: grant.grantId })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await f.service.list({ context, query: { limit: 100 } })).toMatchObject({ ok: true, value: { items: [{ revoked: false }] } });
    expect(f.native.prepare('SELECT outcome FROM measure_egress_audit').all()).toEqual([{ outcome: 'grant_created' }]);
});
