import { PgFoundationError } from '@open-marketing/om-db';
import { prepareMigrations, type Migration } from '../platform/jini-compat/db/src/migrations.js';

/** Global schema order. Append new identities; never renumber or insert historical spine SQL. */
export const migrationManifest = [
    { version: 1, feature: 'workspaces', local: 1, path: 'features/workspaces/migrations/0001_workspaces.sql' },
    { version: 2, feature: 'policy', local: 1, path: 'features/policy/migrations/0001_policy.sql' },
    { version: 3, feature: 'audit', local: 1, path: 'features/audit/migrations/0001_audit.sql' },
    { version: 4, feature: 'audit', local: 2, path: 'features/audit/migrations/0002_audit_sqlite_immutability.sql' },
    { version: 5, feature: 'credentials', local: 1, path: 'features/credentials/migrations/0001_credentials.sql' },
    { version: 6, feature: 'safety', local: 1, path: 'features/safety/migrations/0001_safety.sql' },
    { version: 7, feature: 'jobs', local: 1, path: 'features/jobs/migrations/0001_jobs.sql' },
    { version: 8, feature: 'media-library', local: 1, path: 'features/media-library/migrations/0001_media_evidence.sql' },
    { version: 9, feature: 'creative', local: 1, path: 'features/creative/migrations/0001_creative.sql' },
    { version: 10, feature: 'campaigns', local: 1, path: 'features/campaigns/migrations/0001_campaigns.sql' },
    { version: 11, feature: 'measure', local: 1, path: 'features/measure/migrations/0001_measure.sql' },
    { version: 12, feature: 'measure', local: 2, path: 'features/measure/migrations/0002_attribution_account.sql' },
    { version: 13, feature: 'forms', local: 1, path: 'features/forms/migrations/0001_forms.sql' },
    { version: 14, feature: 'contacts', local: 1, path: 'features/contacts/migrations/0001_contacts.sql' },
    { version: 15, feature: 'web-events', local: 1, path: 'features/web-events/migrations/0001_web_events.sql' },
    { version: 16, feature: 'privacy', local: 1, path: 'features/privacy/migrations/0001_privacy.sql' },
    { version: 17, feature: 'server', local: 1, path: 'apps/server/migrations/0001_assistant.sql' },
    { version: 18, feature: 'server', local: 2, path: 'apps/server/migrations/0002_addons.sql' },
    { version: 19, feature: 'safety', local: 2, path: 'features/safety/migrations/0002_confirmations.sql' },
    { version: 20, feature: 'server', local: 3, path: 'apps/server/migrations/0003_tool_operations.sql' },
    { version: 21, feature: 'server', local: 4, path: 'apps/server/migrations/0004_media.sql' },
    { version: 22, feature: 'server', local: 5, path: 'apps/server/migrations/0005_chat_backend.sql' },
] as const;

/** Load trusted scripts through injected filesystem access; validate the full batch before execution.
 * @throws PgFoundationError for duplicate identities or invalid/oversized SQL; loader errors propagate.
 * @example const migrations = await loadMigrations({ readSql });
 * @complexity O(n log n + b) time/space for n manifest entries and b SQL bytes, bounded by prepareMigrations.
 */
export async function loadMigrations(required: { readSql: (required: { path: string }) => Promise<string> }): Promise<Migration[]> {
    const identities = migrationManifest.map(entry => `${entry.feature}-${entry.local}`);
    if (new Set(identities).size !== identities.length) {
        throw new PgFoundationError({ code: 'duplicate_migration', message: 'Feature migration identities must be unique' });
    }
    const migrations: Migration[] = [];
    for (const entry of migrationManifest) {
        migrations.push({ version: entry.version, name: `${entry.feature}-${entry.local}`, sql: await required.readSql({ path: entry.path }) });
    }
    return prepareMigrations({ migrations });
}
