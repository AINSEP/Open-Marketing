/** Plugin-owned Graph encoding. The host wraps this dispatch with admission, halt and outbox checks. */
import { z } from 'zod';
import type { CallContext, CallOptions, Outcome } from '@open-marketing/contracts';
import type { MetaInstagramDispatch } from './instagram.js';
import { failure } from './boundary.js';

/** Fresh per-call credential resolver; no credential is retained in the dispatch closure. */
export interface MetaInstagramFetchCredentials {
  access(required: { context: CallContext; connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>>;
}

/** Create one bounded Graph request with no redirects or retries. The host must recheck authority
 * after credential lookup (its injected fetch is the final fence). Responses remain tainted until
 * invokeMetaInstagram validates them. Errors contain no provider body or credentials.
 * @example createMetaInstagramFetchDispatch({ fetch: guardedFetch, credentials })
 * @complexity O(b) time/space, <=1 MiB response and <=64 KiB request, one <=15s fetch.
 */
export function createMetaInstagramFetchDispatch(required: { fetch: typeof fetch; credentials: MetaInstagramFetchCredentials }): MetaInstagramDispatch {
  return async (input, options) => {
    const signal = AbortSignal.any([AbortSignal.timeout(Math.min(input.timeoutMs, 15000)), ...(options?.signal ? [options.signal] : [])]);
    if (signal.aborted) return failure({ code: 'cancelled', message: 'Instagram request cancelled' });
    const request = encodeRequest({ input });
    if (!request.ok) return request;
    try {
      const access = await required.credentials.access({ context: input.context, connectionId: input.connectionId, accountId: input.effect.accountId }, { signal });
      if (!access.ok) return failure({ code: access.error.code, message: 'Instagram credential unavailable' });
      const credential = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }).safeParse(access.value);
      if (!credential.success) return failure({ code: 'invalid_input', message: 'Instagram credential invalid' });
      if (signal.aborted) return failure({ code: 'cancelled', message: 'Instagram request cancelled' });
      const response = await required.fetch(request.value.url, {
        method: input.request.method, headers: { Authorization: 'Bearer ' + credential.data.accessToken, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: request.value.body, redirect: 'error', signal,
      });
      if (!response.ok) { await response.body?.cancel(); return failure({ code: 'unavailable', message: 'Instagram acknowledgement unavailable' }); }
      return await readResponse({ response });
    } catch { return failure({ code: 'unavailable', message: 'Instagram transport outcome unavailable; reconcile writes' }); }
  };
}

/** Keep endpoint/parameter encoding inside the plugin. Credentials cannot be supplied in a URL. */
function encodeRequest(required: { input: Parameters<MetaInstagramDispatch>[0] }): Outcome<{ url: string; body?: string }> {
  const { input } = required;
  if (!/^https:\/\/graph\.facebook\.com\/v[1-9][0-9]{0,2}\.[0-9]{1,2}\/(?:me\/accounts|[1-9][0-9]*(?:\/(?:media|media_publish|content_publishing_limit|insights))?)$/.test(input.request.endpoint))
    return failure({ code: 'forbidden', message: 'Instagram destination outside plugin scope' });
  const parameters = new URLSearchParams(Object.entries(input.request.parameters).map(([key, value]) => [key, String(value)]));
  if (parameters.has('access_token') || parameters.toString().length > 65536) return failure({ code: 'invalid_input', message: 'Instagram parameters invalid or oversized' });
  return { ok: true, value: { url: input.request.endpoint + (input.request.method === 'GET' ? '?' + parameters : ''),
    body: input.request.method === 'POST' ? parameters.toString() : undefined } };
}

/** Stream counting bounds allocation even without Content-Length. Parsing does not grant authority. */
async function readResponse(required: { response: Response }): Promise<Outcome<unknown>> {
  const reader = required.response.body?.getReader();
  if (!reader) return failure({ code: 'invalid_input', message: 'Empty Instagram response' });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown };
      size += chunk.value.byteLength;
      if (size > 1048576) return failure({ code: 'limit_exceeded', message: 'Instagram response exceeds 1 MiB' });
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
