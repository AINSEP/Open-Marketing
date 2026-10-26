import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { createSqlMediaRepo } from '../index.js';
import { context, provenance, value } from './fixtures.js';
import { sqlFixture } from './sql-fixture.js';

it('SQL evidence survives closing and reopening an isolated temporary database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'om-media-sql-')); const path = join(directory, 'evidence.sqlite');
  let fixture = await sqlFixture({ filename: path });
  try {
    const first = createSqlMediaRepo({ scope: context.scope, db: fixture.db });
    expect(await first.appendProvenance({ context, link: { provenance } })).toEqual({ ok: true, value: undefined });
    await fixture.dispose(); fixture = await sqlFixture({ filename: path, migrate: false });
    const reopened = createSqlMediaRepo({ scope: context.scope, db: fixture.db });
    expect(value({ outcome: await reopened.evidence({ context, operationId: 'operation' }) }).provenance).toEqual([{ provenance }]);
  } finally { await fixture.dispose(); await rm(directory, { recursive: true, force: true }); }
});
it('SQL malformed persisted JSON fails as a typed unavailable outcome', async () => {
  const fixture = await sqlFixture();
  try {
    fixture.database.prepare('INSERT INTO om_media_evidence VALUES (?,?,?,?,?,?)').run('owner', 'workspace', 'cost', 'cost', 'operation', '{bad');
    const repo = createSqlMediaRepo({ db: fixture.db, scope: context.scope });
    expect(await repo.evidence({ context, operationId: 'operation' })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  } finally { await fixture.dispose(); }
});
it('SQL evidence read is bounded at 1,000 rows and rejects over-limit records', async () => {
  const fixture = await sqlFixture();
  try {
    const insert = fixture.database.prepare('INSERT INTO om_media_evidence VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 1001; index += 1) insert.run('owner', 'workspace', 'cost', String(index), 'operation', '{}');
    const repo = createSqlMediaRepo({ db: fixture.db, scope: context.scope });
    expect(await repo.evidence({ context, operationId: 'operation' })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
  } finally { await fixture.dispose(); }
});
it('concurrent conflicting SQL retries retain exactly one immutable observation', async () => {
  const fixture = await sqlFixture();
  try {
    const repo = createSqlMediaRepo({ db: fixture.db, scope: context.scope });
    const cost = { operationId: 'operation', observationId: 'cost', kind: 'actual' as const, amount: { currency: 'USD', minorUnits: 1 } };
    const results = await Promise.all([repo.appendCost({ context, cost }), repo.appendCost({ context, cost: { ...cost, amount: { currency: 'USD', minorUnits: 2 } } })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(value({ outcome: await repo.evidence({ context, operationId: 'operation' }) }).costs).toHaveLength(1);
  } finally { await fixture.dispose(); }
});
