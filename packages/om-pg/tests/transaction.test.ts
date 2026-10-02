import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/transaction.js';
import { FakeClient } from './fake-client.js';

describe('withTransaction', () => {
  it('reports committed work explicitly when release fails', async () => {
    const client = new FakeClient();
    client.release = () => { throw new Error('release'); };
    await expect(withTransaction({ pool: client.pool, work: async () => 1 }))
      .rejects.toMatchObject({ code: 'release_after_commit' });
    expect(client.statements.at(-1)?.text).toBe('COMMIT');
  });

  it('preserves primary failure when release also fails', async () => {
    const client = new FakeClient();
    client.release = () => { throw new Error('release'); };
    await expect(withTransaction({ pool: client.pool, work: async () => { throw new Error('body'); } }))
      .rejects.toMatchObject({ code: 'release_after_failure', cause: { errors: [
        expect.objectContaining({ code: 'transaction_failed' }), expect.any(Error),
      ] } });
  });

  it('rejects timeout configuration before acquiring and isolates a throwing observer', async () => {
    const client = new FakeClient();
    await expect(withTransaction({ pool: client.pool, work: async () => 1 }, { statementTimeoutMs: 0 }))
      .rejects.toMatchObject({ code: 'invalid_timeout' });
    expect(client.statements).toEqual([]);
    await expect(withTransaction({ pool: client.pool, work: async () => 1 }, { observer: () => { throw new Error('telemetry'); } }))
      .resolves.toBe(1);
  });
  it('commits on one connection, returns the value and releases once', async () => {
    const client = new FakeClient();
    const result = await withTransaction({ pool: client.pool, work: async (tx) => {
      await tx.query('SELECT work');
      return 42;
    } });
    expect(result).toBe(42);
    expect(client.statements.map((q) => q.text)).toEqual([
      'BEGIN', "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
      'SELECT work', 'COMMIT',
    ]);
    expect(client.releases).toEqual([undefined]);
  });

  it('rolls back a failed body and preserves the failure as cause', async () => {
    const client = new FakeClient();
    const failure = new Error('body');
    await expect(withTransaction({ pool: client.pool, work: async () => { throw failure; } }))
      .rejects.toMatchObject({ code: 'transaction_failed', cause: failure });
    expect(client.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(client.releases).toEqual([undefined]);
  });

  it('destroys the connection if rollback fails and retains both errors', async () => {
    const client = new FakeClient();
    client.failures.set('ROLLBACK', new Error('rollback'));
    await expect(withTransaction({ pool: client.pool, work: async () => { throw new Error('body'); } }))
      .rejects.toMatchObject({ code: 'rollback_failed', cause: { errors: [expect.any(Error), expect.any(Error)] } });
    expect(client.releases).toEqual([true]);
  });

  it('does not run a body after BEGIN fails and evicts the uncertain connection', async () => {
    const client = new FakeClient();
    client.failures.set('BEGIN', new Error('begin'));
    let called = false;
    await expect(withTransaction({ pool: client.pool, work: async () => { called = true; } })).rejects.toThrow();
    expect(called).toBe(false);
    expect(client.releases).toEqual([true]);
  });

  it('does not retry an ambiguous commit', async () => {
    const client = new FakeClient();
    client.failures.set('COMMIT', new Error('connection lost'));
    await expect(withTransaction({ pool: client.pool, work: async () => 1 }))
      .rejects.toMatchObject({ code: 'commit_failed' });
    expect(client.releases).toEqual([true]);
    expect(client.statements.filter((q) => q.text === 'COMMIT')).toHaveLength(1);
  });
});
