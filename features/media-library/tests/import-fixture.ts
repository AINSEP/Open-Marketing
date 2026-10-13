import type { FetchImageRequired } from '@jini-ai/cms/media/import';
import { MediaImportValidationError } from '@jini-ai/cms/media/import';
import { createJiniGuardedAssetImport, createMemoryImageInspection } from '../index.js';
import type { JiniAssetImportDependencies, GuardedAssetImportPort } from '../index.js';
import { bytes, context, dependencies } from './fixtures.js';

export const sourceUrl = 'https://example.com/image.png';
type HttpResponse = Awaited<ReturnType<FetchImageRequired['outboundGuard']['send']>>;
export const imageResponse: HttpResponse = { status: 200, headers: { 'content-type': 'image/png' }, bodyText: '', bodyBytes: bytes,
  bodyBytesTruncated: false, finalUrl: sourceUrl };

/** Strict injected egress fixture. DNS/IP/redirect algorithms are not faked as acceptance evidence.
 * Only the configured GET may reach a reply, and the raw HTTP client is deliberately unusable.
 */
export function importFixture(): { config: JiniAssetImportDependencies; port: GuardedAssetImportPort; requests: Parameters<FetchImageRequired['outboundGuard']['send']>[0][]; reply(required: { response: HttpResponse }): void } {
  const deps = dependencies();
  let response = structuredClone(imageResponse);
  const requests: Parameters<FetchImageRequired['outboundGuard']['send']>[0][] = [];
  const config: JiniAssetImportDependencies = { scope: context.scope, dependencies: deps,
    inspection: createMemoryImageInspection({ scope: context.scope, fixtures: [{ bytes, contentType: 'image/png', image: { width: 1, height: 1, frames: 1 } }] }),
    httpClient: { async send() { throw new Error('Guard was bypassed'); } },
    outboundGuard: { async send(input) {
      requests.push(input);
      if (input.request.method !== 'GET' || input.request.url !== sourceUrl) throw new MediaImportValidationError({ message: 'Fixture URL is not admitted' });
      return structuredClone(response);
    } },
  };
  return { config, port: createJiniGuardedAssetImport(config), requests, reply(input) { response = structuredClone(input.response); } };
}
