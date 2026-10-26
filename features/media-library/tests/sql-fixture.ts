import { readFile } from 'node:fs/promises';
import { createSqliteFixture } from '@open-marketing/om-db/testing';

/** Checked test-only database; reopening supplies no migrations, preserving durable evidence. */
export async function sqlFixture(required: { filename?: string; migrate?: boolean } = {}) {
  const migrations = required.migrate === false ? [] : [await readFile(new URL('../migrations/0001_media_evidence.sql', import.meta.url), 'utf8')];
  const fixture = createSqliteFixture({ migrations }, { filename: required.filename });
  return { db: fixture.database, database: fixture.native, dispose: async () => fixture.close() };
}
