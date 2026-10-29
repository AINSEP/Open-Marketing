/** Server-owned SQL; the feature package owns lifecycle decisions. */
import { z } from 'zod';
import { addonSummarySchema } from '@open-marketing/contracts';
import type { CredentialSqlPort } from '@open-marketing/credentials';
import type { AddonRepository } from '@open-marketing/plugins';
export { addonBoundary, addonFailure } from '@open-marketing/plugins';
export type { PluginService as Addons, AddonDependencies, AddonRepository, AddonPackageAdapter, AddonDescription, PreparedAddon } from '@open-marketing/plugins';

/** Fixed-scope SQL repository. Parameterized statements never persist paths, config or credentials.
 * @example const repo = createSqlAddonRepository({ db });
 * @complexity <=1000 summaries; the 1001st persisted row refuses reads rather than truncating.
 */
export function createSqlAddonRepository(required: { db: CredentialSqlPort }): AddonRepository {
    return {
        async list(input) {
            const rows = await required.db.query({ text: 'SELECT summary FROM addon_package WHERE owner_id=$1 AND workspace_id=$2 ORDER BY kind, addon_id LIMIT 1001', values: [input.context.scope.ownerId, input.context.scope.workspaceId] });
            if (rows.rows.length > 1000) throw new RangeError('Addon catalog limit');
            return rows.rows.map(row => addonSummarySchema.parse(JSON.parse(z.string().max(16384).parse(row.summary))));
        },
        async save(input) {
            const addon = addonSummarySchema.parse(input.addon);
            await required.db.query({ text: 'INSERT INTO addon_package (owner_id,workspace_id,kind,addon_id,summary) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(owner_id,workspace_id,kind,addon_id) DO UPDATE SET summary=excluded.summary',
                values: [input.context.scope.ownerId, input.context.scope.workspaceId, addon.kind, addon.id, JSON.stringify(addon)] });
        },
        async remove(input) {
            await required.db.query({ text: 'DELETE FROM addon_package WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 AND addon_id=$4', values: [input.context.scope.ownerId, input.context.scope.workspaceId, input.kind, input.id] });
        },
    };
}

