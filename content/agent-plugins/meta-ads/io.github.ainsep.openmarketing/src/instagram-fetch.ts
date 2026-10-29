/** Plugin-owned Graph encoding. The host wraps this dispatch with admission, halt and outbox checks. */
import { z } from 'zod';
import { parseBoundary, pluginConfigurationSchema } from '@open-marketing/contracts';
import type { PluginCapabilityDependencies, PluginConfiguration, PluginConnectionConfiguration, CallContext, CallOptions, Outcome } from '@open-marketing/contracts';
import type { MetaInstagramDispatch } from './ports.js';
import { failure } from './boundary.js';

/** One version for Ads reads, deployment encoding/digests and destination validation. */
export const adsGraphVersion = 'v26.0';
export const organicGraphVersion = 'v25.0';

/** Parse canonical configuration and project fresh credentials for all Graph callers.
 * No token survives a call; failures pass through to the redacting transport. O(1) setup.
 * @example createConfiguredDispatch(dependencies)
 */
export function createConfiguredDispatch(required: PluginCapabilityDependencies): Outcome<{ configuration: PluginConfiguration; dispatch: MetaInstagramDispatch }> {
  const configuration = parseBoundary({ schema: pluginConfigurationSchema, input: required.configuration });
  if (!configuration.ok) return configuration;
  const dispatch = bindDispatch({ dependencies: required, accountId: configuration.value.accountId });
  return { ok: true, value: { configuration: configuration.value, dispatch } };
}

/** Project fresh credentials for a validated account or connection-only binding.
 * Returns an inert dispatch; credential failures reach the redacting transport. O(1) time/space setup.
 */
export function bindDispatch(required: { dependencies: Pick<PluginCapabilityDependencies<PluginConfiguration | PluginConnectionConfiguration>, 'fetch' | 'credentials'>; accountId: string | null }): MetaInstagramDispatch {
  return createMetaInstagramFetchDispatch({ fetch: required.dependencies.fetch, credentials: {
    async access(input, options) {
      const access = await required.dependencies.credentials.access({ connectionId: input.connectionId, accountId: required.accountId }, options);
      return access.ok ? { ok: true, value: { accessToken: access.value.accessToken } } : access;
    },
  } });
}

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
  const adsOrigin = `https://graph.facebook.com/${adsGraphVersion}`;
  const adsPath = input.request.endpoint.startsWith(adsOrigin) ? input.request.endpoint.slice(adsOrigin.length) : '';
  const advertisingPath = /^\/act_([1-9][0-9]{0,31})\/(campaigns|adsets|ads)$/.exec(adsPath);
  const advertising = input.request.method === 'POST' && advertisingPath !== null && advertisingPath[1] === input.effect.accountId;
  const reportingPath = /^\/act_([1-9][0-9]{0,31})(?:\/(?:insights|campaigns|ads|adsets|adspixels))?$/.exec(adsPath);
  const reporting = isAdsReportingRequest({ input, reportingPath });
  const targetingSearch = input.request.method === 'GET' && adsPath === '/search' && input.effect.effects.length === 1 && input.effect.effects[0] === 'read';
  const audience = input.request.method === 'POST' && /^\/[1-9][0-9]{0,31}\/users$/.test(adsPath) && input.effect.effects.length === 1 && input.effect.effects[0] === 'write';
  const conversion = input.request.method === 'POST' && /^\/[1-9][0-9]{0,31}\/events$/.test(adsPath) && input.effect.effects.length === 1 && input.effect.effects[0] === 'conversion';
  if (!advertising && !reporting && !targetingSearch && !audience && !conversion && !/^https:\/\/graph\.facebook\.com\/v[1-9][0-9]{0,2}\.[0-9]{1,2}\/(?:me\/accounts|[1-9][0-9]*(?:\/(?:media|media_publish|content_publishing_limit|insights))?)$/.test(input.request.endpoint))
    return failure({ code: 'forbidden', message: 'Instagram destination outside plugin scope' });
  const parameters = new URLSearchParams(Object.entries(input.request.parameters).map(([key, value]) => [key, String(value)]));
  if (parameters.has('access_token') || parameters.toString().length > 65536) return failure({ code: 'invalid_input', message: 'Instagram parameters invalid or oversized' });
  return { ok: true, value: { url: input.request.endpoint + (input.request.method === 'GET' ? '?' + parameters : ''),
    body: input.request.method === 'POST' ? parameters.toString() : undefined } };
}

function isAdsReportingRequest({ input, reportingPath }: { input: Parameters<MetaInstagramDispatch>[0]; reportingPath: RegExpExecArray | null }): boolean {
  return input.request.method === 'GET' && reportingPath !== null && reportingPath[1] === input.effect.accountId && input.effect.effects.length === 1 && input.effect.effects[0] === 'read';
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
