/** Temporary native protocol seam until Jini publishes providerWire; provider identity/data live in plugins. */
import { z } from 'zod';
import type { AssistantSettings, ModelProtocol, ModelProvider, Outcome } from '@open-marketing/contracts';

const jsonRecord = z.record(z.string(), z.json());
const messages = z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(jsonRecord).max(100)]) })).min(1).max(90);
const limit = z.number().int().min(1).max(4096);
const anthropic = z.strictObject({ model: z.string().min(1).max(256), stream: z.literal(true), max_tokens: limit, messages,
 system: z.string().max(131072).optional(), tools: z.array(z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4096).optional(), input_schema: jsonRecord, strict: z.boolean().optional() })).max(100).optional() });
const functionSchema = z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4096).optional(), parameters: jsonRecord, strict: z.boolean().optional() });
const openai = z.strictObject({ model: z.string().min(1).max(256), stream: z.literal(true), max_completion_tokens: limit,
 stream_options: z.strictObject({ include_usage: z.literal(true) }), messages: z.array(jsonRecord).min(1).max(90), tools: z.array(z.strictObject({ type: z.literal('function'), function: functionSchema })).max(100).optional() });
const google = z.strictObject({ contents: z.array(jsonRecord).min(1).max(90), systemInstruction: jsonRecord.optional(), tools: z.array(z.strictObject({ functionDeclarations: z.array(functionSchema.omit({ strict: true })).max(100) })).max(1).optional(), toolConfig: z.strictObject({ functionCallingConfig: z.strictObject({ mode: z.literal('VALIDATED') }) }).optional(), generationConfig: z.strictObject({ maxOutputTokens: limit }) });

const count = z.number().int().nonnegative().max(1e9);
const anthropicCounts = z.object({ input_tokens: count.optional(), output_tokens: count.optional(), cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional(), cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).optional() });
const openaiCounts = z.object({ prompt_tokens: count, completion_tokens: count, prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(), completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional() });
const googleCounts = z.object({ promptTokenCount: count, candidatesTokenCount: count.optional(), thoughtsTokenCount: count.optional(), cachedContentTokenCount: count.optional(), toolUsePromptTokenCount: count.optional() });

/** Normalized totals include cached input and reasoning output. finished is the native end-marker prerequisite. */
export interface RequestUsage { input?: number; output?: number; cachedRead: number; cacheWrite: { '5m': number; '1h': number }; unpriced: boolean; stopped: boolean; finished: boolean }
export function emptyUsage(): RequestUsage { return { cachedRead: 0, cacheWrite: { '5m': 0, '1h': 0 }, unpriced: false, stopped: false, finished: false }; }

/** Protocol paths/authentication are independent of installed provider IDs and endpoints. Azure is unsupported. */
export const modelProtocols = {
 anthropic: { inboundSuffix: '/v1/messages', upstreamPath: '/v1/messages', tokenHeader: 'x-api-key', requestSchema: anthropic,
  authHeaders: ({ apiKey }: { apiKey: string }): Record<string, string> => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }) },
 openai: { inboundSuffix: '/chat/completions', upstreamPath: '/v1/chat/completions', tokenHeader: 'authorization', requestSchema: openai,
  authHeaders: ({ apiKey }: { apiKey: string }): Record<string, string> => ({ authorization: 'Bearer ' + apiKey }) },
 google: { inboundSuffix: '/v1beta/models/{model}:streamGenerateContent', upstreamPath: '/v1beta/models/{model}:streamGenerateContent?alt=sse', tokenHeader: 'x-goog-api-key', requestSchema: google,
  authHeaders: ({ apiKey }: { apiKey: string }): Record<string, string> => ({ 'x-goog-api-key': apiKey }) },
} satisfies Partial<Record<ModelProtocol, unknown>>;
type SupportedProtocol = keyof typeof modelProtocols;

/** Match only a native suffix; the broker later binds provider/protocol/model to the frozen run.
 * O(path) parsing, with bounded decoded IDs. Malformed encoding returns no route.
 */
export function modelRoute(required: { path: string }): { providerId: string; protocol: SupportedProtocol; wireModel?: string } | undefined {
 const match = /^\/api\/agent\/v1\/model\/([^/]+)(\/.*)$/.exec(required.path);
 if (!match) return undefined;
 try {
  const providerId = decodeURIComponent(match[1]);
  if (!providerId.length || providerId.length > 256) return undefined;
  for (const protocol of Object.keys(modelProtocols) as SupportedProtocol[]) {
   const suffix = modelProtocols[protocol].inboundSuffix;
   if (suffix === match[2]) return { providerId, protocol };
  }
  const native = /^\/v1beta\/models\/([^/]+):streamGenerateContent$/.exec(match[2]);
  if (native) return { providerId, protocol: 'google', wireModel: decodeURIComponent(native[1]) };
 } catch { /* Malformed encoded identifiers cannot select a protocol. */ }
 return undefined;
}

/** A validated body wins recursively at every leaf; declared efforts can only supply missing fields.
 * O(body + fragment), bounded by the existing request/declaration schemas. No input mutation.
 */
function mergeEffort(required: { fragment: Record<string, unknown>; body: Record<string, unknown> }): Record<string, unknown> {
 const result = { ...required.fragment, ...required.body };
 for (const [key, value] of Object.entries(required.body)) {
  const body = plainObject({ value });
  const fragment = plainObject({ value: required.fragment[key] });
  if (body && fragment) result[key] = mergeEffort({ fragment, body });
 }
 return result;
}
function plainObject(required: { value: unknown }): Record<string, unknown> | undefined {
 const { value } = required;
 return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined;
}

/** Serialize one declared effort with body precedence, protocol auth and a declared origin.
 * @example providerRequest({ settings, declaration, body, apiKey });
 * @complexity O(body + fragment); no I/O. Unsupported protocols return a typed refusal.
 */
export function providerRequest(required: { settings: AssistantSettings; declaration: ModelProvider; body: Record<string, unknown>; apiKey: string }): Outcome<{ url: string; headers: Record<string, string>; body: string }> {
 if (required.declaration.protocol === 'azure') return { ok: false, error: { code: 'unavailable', message: 'Model protocol unavailable', retryable: false } };
 const protocol = modelProtocols[required.declaration.protocol];
 const model = required.declaration.models.find(model => model.id === required.settings.model)!;
 const fragment = model.efforts.find(effort => effort.id === required.settings.effort)?.request ?? {};
 return { ok: true, value: { url: required.declaration.endpoint + protocol.upstreamPath.replace('{model}', encodeURIComponent(required.settings.model)),
  headers: protocol.authHeaders({ apiKey: required.apiKey }), body: JSON.stringify(mergeEffort({ fragment, body: required.body })) } };
}

/** Replace cumulative snapshots; normalize cache inclusivity and reasoning before pricing.
 * Invalid usage interrupts the stream; absent usage remains unknown. O(frame), <=64 KiB.
 */
export function captureUsage(required: { protocol: ModelProtocol; data: string; usage: RequestUsage }): void {
 const { usage, protocol, data } = required;
 if (data === '[DONE]' && protocol === 'openai') { usage.stopped = usage.finished; return; }
 if (!data) return;
 const frame = z.object({ type: z.string().optional(), message: z.object({ usage: anthropicCounts.optional() }).optional(), usage: z.unknown().optional(), usageMetadata: googleCounts.optional(), choices: z.array(z.object({ finish_reason: z.string().nullable().optional() })).optional(), candidates: z.array(z.object({ finishReason: z.string().optional() })).optional(), error: z.unknown().optional() }).parse(JSON.parse(data));
 if (frame.error || frame.type === 'error') throw new Error('Provider stream failed');
 if (protocol === 'anthropic') captureAnthropic({ frame, usage });
 if (protocol === 'openai') captureOpenAi({ frame, usage });
 if (protocol === 'google') captureGoogle({ frame, usage });
}
function captureOpenAi(required: { frame: { choices?: { finish_reason?: string | null }[]; usage?: unknown }; usage: RequestUsage }): void {
 const { frame, usage } = required;
 usage.finished ||= frame.choices?.some(choice => !!choice.finish_reason) ?? false;
 if (!frame.usage) return;
 const counts = openaiCounts.parse(frame.usage);
 usage.input = counts.prompt_tokens; usage.output = counts.completion_tokens;
 usage.cachedRead = counts.prompt_tokens_details?.cached_tokens ?? 0;
}
function captureGoogle(required: { frame: { candidates?: { finishReason?: string }[]; usageMetadata?: z.infer<typeof googleCounts> }; usage: RequestUsage }): void {
 const { frame, usage } = required;
 usage.stopped ||= frame.candidates?.some(candidate => !!candidate.finishReason) ?? false;
 if (!frame.usageMetadata) return;
 const counts = frame.usageMetadata;
 usage.input = counts.promptTokenCount;
 usage.output = counts.candidatesTokenCount === undefined ? undefined : counts.candidatesTokenCount + (counts.thoughtsTokenCount ?? 0);
 usage.cachedRead = counts.cachedContentTokenCount ?? 0;
 usage.unpriced ||= !!counts.toolUsePromptTokenCount;
}
/** Start input and final output are complementary; cache snapshots replace, rather than accumulate. */
function captureAnthropic(required: { frame: { type?: string; message?: { usage?: z.infer<typeof anthropicCounts> }; usage?: unknown }; usage: RequestUsage }): void {
 const { frame, usage } = required;
 usage.stopped ||= frame.type === 'message_stop';
 const raw = frame.type === 'message_start' ? frame.message?.usage : frame.usage;
 if (!raw) return;
 const counts = anthropicCounts.parse(raw);
 const previousInput = usage.input === undefined ? undefined : usage.input - usage.cachedRead - usage.cacheWrite['5m'] - usage.cacheWrite['1h'];
 usage.cachedRead = counts.cache_read_input_tokens ?? usage.cachedRead;
 captureCacheWrite({ counts, usage });
 const input = counts.input_tokens ?? previousInput;
 if (input !== undefined) usage.input = input + usage.cachedRead + usage.cacheWrite['5m'] + usage.cacheWrite['1h'];
 if (frame.type === 'message_delta') usage.output = counts.output_tokens ?? usage.output;
}
function captureCacheWrite(required: { counts: z.infer<typeof anthropicCounts>; usage: RequestUsage }): void {
 const { counts, usage } = required;
 if (counts.cache_creation_input_tokens === undefined) return;
 usage.cacheWrite['5m'] = counts.cache_creation?.ephemeral_5m_input_tokens ?? 0;
 usage.cacheWrite['1h'] = counts.cache_creation?.ephemeral_1h_input_tokens ?? 0;
 usage.unpriced ||= counts.cache_creation_input_tokens !== usage.cacheWrite['5m'] + usage.cacheWrite['1h'];
}
