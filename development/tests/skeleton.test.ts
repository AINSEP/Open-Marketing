import { it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspacePackages, sourceFiles } from '../scripts/workspace.mjs';
import { importSpecifiers } from '../scripts/boundaries.mjs';
it('workspace and public entries describe exactly the preserve-only skeleton', () => {
 const packages = workspacePackages();
 expect(packages.filter(pkg => pkg.om?.kind === 'app')).toHaveLength(4);
 expect(packages.filter(pkg => pkg.om?.kind === 'feature')).toHaveLength(12);
 expect(packages.some(pkg => pkg.path.startsWith('development/parked/'))).toBe(false);
 for (const pkg of packages.filter(pkg => pkg.om?.kind === 'feature')) {
  expect(Object.keys(pkg.exports)).toEqual(['.']); expect(pkg.exports['.'].types).toBe('./index.ts');
  expect(readFileSync(pkg.path+'/index.ts','utf8')).not.toMatch(/export\s+\*/);
  for (const file of ['src/ports.ts','src/types.ts','src/memory.ts','tests/contract/port-suites.ts']) expect(existsSync(pkg.path+'/'+file)).toBe(true);
 }
});
const portableManifest = z.strictObject({ $schema: z.literal('https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'), name: z.string(), version: z.literal('0.0.0'), description: z.string(), license: z.literal('Apache-2.0'), extensions: z.strictObject({ 'io.github.ainsep.openmarketing': z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.strictObject({}) }) }) });
it.each(['higgsfield-media','google-ads','meta-ads','om-playbook'])('portable %s skeleton admits no capability or vendor configuration', name => {
 const path = 'content/agent-plugins/'+name;
 expect(portableManifest.parse(JSON.parse(readFileSync(path+'/plugin.json','utf8'))).name).toBe(name);
 expect(JSON.parse(readFileSync(path+'/mcp.json','utf8'))).toEqual({ $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: {} });
 for (const file of ['LICENSE','NOTICE']) expect(existsSync(path+'/'+file)).toBe(true);
});
it('applied migration history is preserved byte-for-byte and original UI evidence stays inert', () => {
 const snapshot = JSON.parse(readFileSync('development/preserve-inputs.json','utf8'));
 const migration = readFileSync('apps/server/src/platform/jini-compat/db/migrations/0001_spine.sql');
 expect(createHash('sha256').update(migration).digest('hex')).toBe(snapshot.sha256['packages/om-pg/migrations/0001_spine.sql']);
 for (const name of ['OMChatPane.tsx','OMChatPane.hooks.ts','nav-tools.ts']) {
  const old = snapshot.sha256['apps/web/src/components/om-chat/'+name];
  if (old) expect(createHash('sha256').update(readFileSync('development/provenance/om-chat/'+name+'.txt')).digest('hex')).toBe(old);
 }
});
it('active imports and root commands contain no Open Design runtime or compatibility command', () => {
 for (const file of sourceFiles()) {
  for (const entry of importSpecifiers({ source: readFileSync(file,'utf8'), file })) expect(entry.specifier ?? '').not.toMatch(/@open-design\/|apps\/(web|daemon)\/|tools-(dev|pack|serve)|od-guard/);
 }
 const scripts = JSON.parse(readFileSync('package.json','utf8')).scripts;
 expect(Object.keys(scripts).every(name => name.startsWith('om:'))).toBe(true);
});
