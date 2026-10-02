import { build } from 'esbuild';

await Promise.all([
  build({ bundle: true, entryPoints: ['./src/index.ts'], outdir: './dist',
    format: 'esm', outExtension: { '.js': '.mjs' }, packages: 'external', platform: 'node', target: 'node24' }),
  build({ bundle: true, entryPoints: ['./src/index.ts'], outdir: './dist',
    format: 'cjs', outExtension: { '.js': '.cjs' }, packages: 'external', platform: 'node', target: 'node24' }),
]);
