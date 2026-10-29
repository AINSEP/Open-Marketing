import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

/** Build declared agent-plugin packages in order; stop on the first failure. */
for (const manifestPath of globSync('content/agent-plugins/*/package.json', { cwd: root }).sort()) {
 const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
 if (typeof manifest.scripts?.build !== 'string') continue;
 const directory = dirname(manifestPath);
 console.log(`Building ${directory}`);
 const result = spawnSync('pnpm', ['--dir', directory, 'build'], { cwd: root, stdio: 'inherit' });
 if (result.error) console.error(result.error.message);
 if (result.status !== 0) process.exit(result.status ?? 1);
}
