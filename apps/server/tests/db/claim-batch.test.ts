import { describe, expect, it } from 'vitest';
import { claimBatch } from '../../src/platform/jini-compat/db/src/claim-batch.js';
import { FakeClient } from './fake-client.js';
const queue = { schema: 'om', table: 'outbox' };
const input = { queue, allowedTables: [queue], tenantId: 'tenant', workspaceId: 'workspace',
    limit: 10, now: new Date('2026-01-01T00:00:00Z'), leaseUntil: new Date('2026-01-01T00:01:00Z') };
describe('claimBatch', () => {
    it('claims in one transaction with parameterized scope, lease and bounded serialized selection', async () => {
        const client = new FakeClient();
        client.rows = [{ id: 'job' }];
        expect(await claimBatch({ ...input, pool: client.pool })).toEqual([{ id: 'job' }]);
        const claim = client.statements.find((q) => q.text.startsWith('WITH candidates'))!;
        expect(claim.text).toContain('LIMIT $4');
        expect(claim.text).not.toContain('SKIP LOCKED');
        expect(claim.text).toContain('"om_outbox"');
        expect(claim.text).toContain('queue.workspace_id = $2');
        expect(claim.text).toContain('attempts = queue.attempts + 1');
        expect(claim.values).toEqual(['tenant', 'workspace', input.now.toISOString(), 10, input.leaseUntil.toISOString()]);
        expect(client.statements.at(-1)?.text).toBe('COMMIT');
    });
    it.each([0, 1001, 1.5, NaN])('rejects invalid limit %s before I/O', async (limit: number) => {
        const client = new FakeClient();
        await expect(claimBatch({ ...input, pool: client.pool, limit })).rejects.toMatchObject({ code: 'invalid_limit' });
        expect(client.statements).toEqual([]);
    });
    it('rejects unknown queues and even allowlisted malformed identifiers', async () => {
        const client = new FakeClient();
        await expect(claimBatch({ ...input, pool: client.pool, allowedTables: [] })).rejects.toMatchObject({ code: 'queue_not_allowed' });
        const bad = { schema: 'om', table: 'outbox; DROP TABLE subject' };
        await expect(claimBatch({ ...input, pool: client.pool, queue: bad, allowedTables: [bad] }))
            .rejects.toMatchObject({ code: 'invalid_identifier' });
        expect(client.statements).toEqual([]);
    });
    it('rejects expired and invalid leases', async () => {
        const client = new FakeClient();
        await expect(claimBatch({ ...input, pool: client.pool, leaseUntil: input.now })).rejects.toMatchObject({ code: 'invalid_lease' });
        await expect(claimBatch({ ...input, pool: client.pool, now: new Date(NaN) })).rejects.toMatchObject({ code: 'invalid_lease' });
    });
    it('rejects schema/table pairs that collide after portable name flattening before I/O', async () => {
        const client = new FakeClient();
        const collision = { schema: 'om_out', table: 'box' };
        const selected = { schema: 'om', table: 'out_box' };
        await expect(claimBatch({ ...input, pool: client.pool, queue: selected, allowedTables: [selected, collision] })).rejects.toMatchObject({ code: 'ambiguous_queue' });
        expect(client.statements).toEqual([]);
    });
});
