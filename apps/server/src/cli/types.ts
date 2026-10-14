/** Leaf contracts for the HTTP-only CLI and its executable-owned file readers. */
import type { AddonUpload } from '@open-marketing/contracts';
import type { ApprovalRuntime } from './approval.js';
import type { HttpRuntime } from './http.js';

/** Folder reads belong to executable composition; ZIP/stdin use readPrompt. */
export interface AddonCliFiles {
  readFolder(required: { path: string; signal: AbortSignal }): Promise<AddonUpload>;
}

/** Inject once in the Node launcher; tests supply an in-memory runtime.
 * readPrompt yields bounded file/stdin chunks while honoring the signal.
 * confirm requires explicit terminal confirmation; output sinks are synchronous.
 */
export interface CliRuntime extends HttpRuntime, ApprovalRuntime {
  readonly stdout: { write(required: { text: string }): void };
  readonly readPrompt: (required: { path: string; signal: AbortSignal }) => AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly addonFiles?: AddonCliFiles;
}
