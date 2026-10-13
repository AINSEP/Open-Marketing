import { it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { capabilityEnvelopeSchema } from '@open-marketing/contracts';
import { workspacePackages, sourceFiles } from '../scripts/workspace.mjs';
import { importSpecifiers } from '../scripts/boundaries.mjs';
it('workspace features expose only their public entries and keep parked source isolated', () => {
 const packages = workspacePackages();
 expect(packages.filter(pkg => pkg.om?.kind === 'app')).toHaveLength(4);
 expect(packages.filter(pkg => pkg.om?.kind === 'feature')).toHaveLength(16);
 expect(packages.some(pkg => pkg.path.startsWith('development/parked/'))).toBe(false);
 for (const pkg of packages.filter(pkg => pkg.om?.kind === 'feature')) {
  expect(Object.keys(pkg.exports)).toEqual(['.']); expect(pkg.exports['.'].types).toBe('./index.ts');
  expect(readFileSync(pkg.path+'/index.ts','utf8')).toMatch(/export\s/);
  for (const file of ['src/ports.ts','src/types.ts','src/memory.ts']) expect(existsSync(pkg.path+'/'+file)).toBe(true);
  const suite = { forms: 'tests/port-suites.ts', privacy: 'tests/ports.test.ts', 'web-events': 'tests/port-suite.ts' }[pkg.name.replace('@open-marketing/', '')] ?? 'tests/contract/port-suites.ts';
  expect(existsSync(pkg.path+'/'+suite)).toBe(true);
 }
});
const declarations = z.union([z.array(capabilityEnvelopeSchema.extend({ pluginDigest: z.string().optional(), admitted: z.literal(false) })), z.record(z.string(), z.strictObject({ server: z.string(), binding: z.string().startsWith('./io.github.ainsep.openmarketing/') }))]);
const serverMetadata = z.strictObject({ authMode: z.enum(['oauth','none','host']).optional(), defaultTools: z.strictObject({ discover: z.array(z.string()) }).optional(), riskHints: z.record(z.string(), z.array(z.enum(['read','write','spend','destructive']))).optional() });
const portableManifest = z.strictObject({ $schema: z.literal('https://agent-plugins.org/schemas/1.1.0/plugin.schema.json'), name: z.string(), version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string(), author: z.strictObject({ name: z.string() }).optional(), keywords: z.array(z.string()).optional(), license: z.literal('Apache-2.0'), extensions: z.strictObject({ 'io.github.ainsep.openmarketing': z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: declarations, servers: z.record(z.string(), serverMetadata).optional() }) }) });
const transport = z.union([z.strictObject({ type: z.literal('stdio'), command: z.literal('node'), args: z.array(z.string()), cwd: z.literal('${PLUGIN_ROOT}') }), z.strictObject({ type: z.literal('streamable-http'), url: z.string().startsWith('https://') })]);
it.each(['higgsfield-media','google-ads','meta-ads','om-playbook'])('portable %s stays disabled and unadmitted with closed transport configuration', name => {
 const path = 'content/agent-plugins/'+name;
 expect(portableManifest.parse(JSON.parse(readFileSync(path+'/plugin.json','utf8'))).name).toBe(name);
 const mcp = z.strictObject({ $schema: z.literal('https://agent-plugins.org/schemas/1.1.0/mcp.schema.json'), mcpServers: z.record(z.string(), transport) }).parse(JSON.parse(readFileSync(path+'/mcp.json','utf8')));
 const declaredServers = portableManifest.parse(JSON.parse(readFileSync(path+'/plugin.json','utf8'))).extensions['io.github.ainsep.openmarketing'].servers ?? {};
 expect(Object.keys(declaredServers).every(server => server in mcp.mcpServers)).toBe(true);
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
}, 30000);
