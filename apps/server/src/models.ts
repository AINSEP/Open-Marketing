/** Fixed API catalogue; identifiers/effort are shared by settings and the sealed-key broker. */
import { z } from 'zod';
import type { AssistantProvider, AssistantSettings } from '@open-marketing/contracts';

const standard = ['low', 'medium', 'high', 'max'];
export const modelCatalogue = [
 { provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: standard, input: 2, output: 10, cached: .10, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
 { provider: 'anthropic', id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: standard, input: 4, output: 20, cached: .20, source: 'https://platform.claude.com/docs/en/about-claude/pricing' },
 { provider: 'openai', id: 'gpt-5.2', label: 'GPT-5.2', efforts: ['none', 'low', 'medium', 'high', 'xhigh'], input: 1.75, output: 14, cached: .175, source: 'https://developers.openai.com/api/docs/models/gpt-5.2' },
 { provider: 'google', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', efforts: ['off', 'low', 'high'], input: .30, output: 2.50, cached: .03, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
];
export const pricingDate = '2026-10-24';
export const providerNames = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI (GPT)', google: 'Google (Gemini)' };
export const modelRoutes = {
 anthropic: '/api/agent/v1/model/anthropic/v1/messages',
 openai: '/api/agent/v1/model/openai/chat/completions',
 google: '/api/agent/v1/model/google/v1beta/models/gemini-2.5-flash:streamGenerateContent',
};
/** Unknown provider/model/effort combinations fail before acceptance or credential access. O(4). */
export function selectedModel(required: { settings: AssistantSettings }) {
 const { settings } = required;
 return modelCatalogue.find(model => model.provider === (settings.provider ?? 'anthropic') && model.id === settings.model
  && (!settings.effort || settings.effort === 'default' || model.efforts.includes(settings.effort)));
}
export function modelChoices(required: { provider: AssistantProvider }) {
 return modelCatalogue.filter(model => model.provider === required.provider).map(model => ({ id: model.id, label: model.label,
  reasoning: ['default', ...model.efforts].map(id => ({ id, label: id === 'default' ? 'Default' : id })) }));
}
const jsonRecord = z.record(z.string(), z.json());
const messages = z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(jsonRecord).max(100)]) })).min(1).max(90);
const limit = z.number().int().min(1).max(4096);
const anthropic = z.strictObject({ model: z.string().min(1).max(256), stream: z.literal(true), max_tokens: limit, messages,
 system: z.string().max(131072).optional(), tools: z.array(z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4096).optional(), input_schema: jsonRecord, strict: z.boolean().optional() })).max(100).optional() });
const functionSchema = z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4096).optional(), parameters: jsonRecord, strict: z.boolean().optional() });
const openai = z.strictObject({ model: z.literal('gpt-5.2'), stream: z.literal(true), max_completion_tokens: limit,
 stream_options: z.strictObject({ include_usage: z.literal(true) }), messages: z.array(jsonRecord).min(1).max(90), tools: z.array(z.strictObject({ type: z.literal('function'), function: functionSchema })).max(100).optional() });
const google = z.strictObject({ contents: z.array(jsonRecord).min(1).max(90), systemInstruction: jsonRecord.optional(), tools: z.array(z.strictObject({ functionDeclarations: z.array(functionSchema.omit({ strict: true })).max(100) })).max(1).optional(), toolConfig: z.strictObject({ functionCallingConfig: z.strictObject({ mode: z.literal('VALIDATED') }) }).optional(), generationConfig: z.strictObject({ maxOutputTokens: limit }) });
export const modelRequestSchemas = { anthropic, openai, google };

/** Construct native effort fields only from frozen server settings; default adds no field.
 * Effort evidence: https://platform.claude.com/docs/en/build-with-claude/effort,
 * https://ai.google.dev/gemini-api/docs/thinking. Google 2.5 uses a token budget, not Gemini 3's thinkingLevel. No Anthropic thinking mode.
 * @complexity O(b) for the request copy; b <=256 KiB.
 */
export function providerRequest(required: { settings: AssistantSettings; body: Record<string, unknown>; apiKey: string }) {
 const provider = required.settings.provider ?? 'anthropic';
 const effort = required.settings.effort;
 const body = { ...required.body };
 if (effort && effort !== 'default') {
  if (provider === 'anthropic') body.output_config = { effort };
  if (provider === 'openai') body.reasoning_effort = effort;
  if (provider === 'google') body.generationConfig = { ...required.body.generationConfig as object, thinkingConfig: { thinkingBudget: ({ off: 0, low: 1024, high: 3072 } as Record<string, number>)[effort] } };
 }
 const destinations = { anthropic: 'https://api.anthropic.com/v1/messages', openai: 'https://api.openai.com/v1/chat/completions', google: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' };
 const authentication = { anthropic: { 'x-api-key': required.apiKey, 'anthropic-version': '2023-06-01' }, openai: { authorization: 'Bearer ' + required.apiKey }, google: { 'x-goog-api-key': required.apiKey } };
 return { url: destinations[provider], headers: authentication[provider] as Record<string, string>, body: JSON.stringify(body) };
}
