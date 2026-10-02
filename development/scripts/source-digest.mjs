import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceFiles } from './workspace.mjs';
/** The same canonical source fingerprint is used at build and verification. */
export function sourceDigest({ root, owner }) {
 const files = sourceFiles({ root }).filter(file => file.startsWith(owner.path + '/')).sort();
 return createHash('sha256').update(files.map(file => file + createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')).join('\n')).digest('hex');
}
