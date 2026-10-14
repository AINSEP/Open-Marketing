/** Test-only cleanup for state containing Jini's immutable package snapshots. */
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

/** Make owned directories writable before removal; never follow symlinks.
 * Missing roots are allowed, other filesystem errors propagate to the test.
 * @example await removeStateRoot({ path: directory });
 * @complexity O(entries) filesystem work, O(depth) stack space.
 */
export async function removeStateRoot(required: { path: string }): Promise<void> {
    await makeWritable(required);
    await fs.rm(required.path, { recursive: true, force: true });
}

/** Only parent-directory permissions need changing to unlink read-only files on POSIX. */
async function makeWritable(required: { path: string }): Promise<void> {
    let stat;
    try { stat = await fs.lstat(required.path); }
    catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
        throw error;
    }
    if (!stat.isDirectory()) return;
    await fs.chmod(required.path, 0o700);
    for (const entry of await fs.readdir(required.path, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable({ path: join(required.path, entry.name) });
    }
}
