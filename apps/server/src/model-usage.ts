/** Server-owned request evidence. No agent-supplied number can establish a charge. */
import { z } from 'zod';
import type { AssistantProvider, AssistantUsage, RunGrantMetadata } from '@open-marketing/contracts';
import type { CampaignSqlPort } from '@open-marketing/campaigns';
import { modelCatalogue, pricingDate } from './models.js';

const count = z.number().int().nonnegative().max(1e9);
const anthropicCounts = z.object({ input_tokens: count.optional(), output_tokens: count.optional(), cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional(), cache_creation: z.object({ ephemeral_5m_input_tokens: count, ephemeral_1h_input_tokens: count }).optional() });
const openaiCounts = z.object({ prompt_tokens: count, completion_tokens: count, prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(), completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional() });
const googleCounts = z.object({ promptTokenCount: count, candidatesTokenCount: count.optional(), thoughtsTokenCount: count.optional(), cachedContentTokenCount: count.optional(), toolUsePromptTokenCount: count.optional() });
export interface RequestUsage { input?: number; output?: number; cached: number; write5: number; write1: number; reasoning: number; unpriced: boolean; stopped: boolean; finished: boolean }
export function emptyUsage(): RequestUsage { return { cached: 0, write5: 0, write1: 0, reasoning: 0, unpriced: false, stopped: false, finished: false }; }

/** Replace cumulative snapshots; Anthropic start input and final output are complementary.
 * Invalid usage interrupts the stream; absent usage remains unknown. O(frame), <=64 KiB.
 */
export function captureUsage(required: { provider: AssistantProvider; data: string; usage: RequestUsage }): void {
 const { usage, provider, data } = required;
 if (data === '[DONE]' && provider === 'openai') { usage.stopped = usage.finished; return; }
 if (!data) return;
 const frame = z.object({ type: z.string().optional(), message: z.object({ usage: anthropicCounts.optional() }).optional(), usage: z.unknown().optional(), usageMetadata: googleCounts.optional(), choices: z.array(z.object({ finish_reason: z.string().nullable().optional() })).optional(), candidates: z.array(z.object({ finishReason: z.string().optional() })).optional(), error: z.unknown().optional() }).parse(JSON.parse(data));
 if (frame.error || frame.type === 'error') throw new Error('Provider stream failed');
 if (provider === 'anthropic') captureAnthropic({ frame, usage });
 if (provider === 'openai') captureOpenAi({ frame, usage });
 if (provider === 'google') captureGoogle({ frame, usage });
}
function captureOpenAi(required: { frame: { choices?: { finish_reason?: string | null }[]; usage?: unknown }; usage: RequestUsage }): void {
 const { frame, usage } = required;
  usage.finished ||= frame.choices?.some(choice => !!choice.finish_reason) ?? false;
  if (frame.usage) {
   const counts = openaiCounts.parse(frame.usage);
   usage.input = counts.prompt_tokens; usage.output = counts.completion_tokens;
   usage.cached = counts.prompt_tokens_details?.cached_tokens ?? 0; usage.reasoning = counts.completion_tokens_details?.reasoning_tokens ?? 0;
  }
}
function captureGoogle(required: { frame: { candidates?: { finishReason?: string }[]; usageMetadata?: z.infer<typeof googleCounts> }; usage: RequestUsage }): void {
 const { frame, usage } = required;
  usage.stopped ||= frame.candidates?.some(candidate => !!candidate.finishReason) ?? false;
  if (frame.usageMetadata) {
   const counts = frame.usageMetadata;
   usage.input = counts.promptTokenCount; usage.output = counts.candidatesTokenCount;
   usage.reasoning = counts.thoughtsTokenCount ?? 0; usage.cached = counts.cachedContentTokenCount ?? 0;
   usage.unpriced ||= !!counts.toolUsePromptTokenCount;
  }
}
function captureAnthropic(required: { frame: { type?: string; message?: { usage?: z.infer<typeof anthropicCounts> }; usage?: unknown }; usage: RequestUsage }): void {
 const { frame, usage } = required;
 usage.stopped ||= frame.type === 'message_stop';
 const raw = frame.type === 'message_start' ? frame.message?.usage : frame.usage;
 if (!raw) return;
 const counts = anthropicCounts.parse(raw);
 usage.input = counts.input_tokens ?? usage.input;
 if (frame.type === 'message_delta') usage.output = counts.output_tokens ?? usage.output;
 usage.cached = counts.cache_read_input_tokens ?? usage.cached;
 if (counts.cache_creation_input_tokens !== undefined) {
  usage.write5 = counts.cache_creation?.ephemeral_5m_input_tokens ?? 0; usage.write1 = counts.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  usage.unpriced ||= counts.cache_creation_input_tokens !== usage.write5 + usage.write1;
 }
}
/** Standard API estimate; reasoning is already in OpenAI output, separate only on Google.
 * Cache counts are inclusive on OpenAI/Google and exclusive on Anthropic. O(4), no rounding.
 */
export function requestEstimate(required: { provider: AssistantProvider; model: string; usage: RequestUsage }): number | undefined {
 const { usage, provider } = required;
 const price = modelCatalogue.find(model => model.id === required.model && model.provider === provider);
 if (!price || usage.unpriced || usage.input === undefined || usage.output === undefined) return undefined;
 const inclusive = provider !== 'anthropic';
 if (inclusive && usage.cached > usage.input) return undefined;
 const input = usage.input - (inclusive ? usage.cached : 0);
 const output = usage.output + (provider === 'google' ? usage.reasoning : 0);
 return (input * price.input + output * price.output + usage.cached * price.cached + usage.write5 * price.input * 1.25 + usage.write1 * price.input * 2) / 1e6;
}
/** Append intent before egress and at most one completion after EOF. No updates/deletes/retries.
 * An absent completion proves an unknown outcome after interruption or process loss. O(1) write.
 */
export async function appendUsage(required: { db: CampaignSqlPort; grant: RunGrantMetadata; requestId: string; kind: 'intent' | 'completion'; provider: AssistantProvider; model: string; now: number; usage?: RequestUsage }): Promise<void> {
 const cost = required.usage?.stopped ? requestEstimate({ ...required, usage: required.usage }) : undefined;
 const price = modelCatalogue.find(model => model.id === required.model);
 const written = await required.db.query({ text: 'INSERT INTO om_model_usage(request_id,kind,run_id,owner_id,workspace_id,recorded_at,input_tokens,output_tokens,cost_usd,evidence_json) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE $2=\'completion\' OR (SELECT COUNT(*) FROM om_model_usage WHERE run_id=$3 AND owner_id=$4 AND workspace_id=$5 AND kind=\'intent\')<25',
  values: [required.requestId, required.kind, required.grant.runId, required.grant.scope.ownerId, required.grant.scope.workspaceId, required.now, required.usage?.input === undefined ? null : required.usage.input + (required.provider === 'anthropic' ? required.usage.cached + required.usage.write5 + required.usage.write1 : 0),
   required.usage?.output === undefined ? null : required.usage.output + (required.provider === 'google' ? required.usage.reasoning : 0), cost ?? null, JSON.stringify({ provider: required.provider, model: required.model, pricingDate, source: price?.source, rates: price && { input: price.input, output: price.output, cached: price.cached }, usage: required.usage })] });
 if (written.rowCount !== 1) throw new Error('Model request limit reached');
}
/** One grouped SQL read across the conversation prefix, independent of history pagination.
 * Missing intents, receipts, or prices suppress dollars for that turn and every later total.
 * @complexity O(r) indexed receipt aggregation for r requests; returns one summary row.
 */
export async function readUsage(required: { db: CampaignSqlPort; runId: string; ownerId: string; workspaceId: string }): Promise<AssistantUsage> {
 const result = await required.db.query({ text: `WITH turns AS (
 SELECT r.run_id, COUNT(CASE WHEN u.kind='intent' THEN 1 END) AS intents,
 COUNT(CASE WHEN u.kind='completion' THEN 1 END) AS receipts, COUNT(u.cost_usd) AS priced,
 SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cost_usd) AS cost, m.ended_at-COALESCE(m.started_at,m.created_at) AS duration
 FROM om_assistant_runs r JOIN ai_chat_messages m ON m.id=r.message_id
 LEFT JOIN om_model_usage u ON u.run_id=r.run_id AND u.owner_id=r.owner_id AND u.workspace_id=r.workspace_id
 WHERE r.owner_id=$2 AND r.workspace_id=$3 AND r.conversation_id=(SELECT conversation_id FROM om_assistant_runs WHERE run_id=$1 AND owner_id=$2 AND workspace_id=$3)
 AND m.position <= (SELECT position FROM ai_chat_messages WHERE run_id=$1 AND role='assistant')
 AND r.settings_json LIKE '%"mode":"model"%' GROUP BY r.run_id,m.ended_at,m.started_at,m.created_at
 ), summaries AS (SELECT *, CASE WHEN intents>0 AND intents=receipts AND receipts=priced THEN 1 ELSE 0 END AS complete FROM turns)
 SELECT MAX(CASE WHEN run_id=$1 THEN complete ELSE 0 END) AS complete,
 MAX(CASE WHEN run_id=$1 THEN input_tokens END) AS input_tokens, MAX(CASE WHEN run_id=$1 THEN output_tokens END) AS output_tokens,
 MAX(CASE WHEN run_id=$1 THEN cost END) AS cost, MAX(CASE WHEN run_id=$1 THEN duration END) AS duration, MIN(complete) AS prefix_complete, SUM(cost) AS total_cost FROM summaries`,
 values: [required.runId, required.ownerId, required.workspaceId] });
 const row = result.rows[0];
 const complete = Number(row?.complete) === 1;
 const prefixComplete = Number(row?.prefix_complete) === 1;
 return { kind: 'usage', complete: complete && prefixComplete, ...(row?.duration == null ? {} : { durationMs: Math.max(0, Number(row.duration)) }), costBasis: complete ? 'estimated' : 'unavailable',
  ...(row?.input_tokens == null ? {} : { inputTokens: Number(row.input_tokens) }), ...(row?.output_tokens == null ? {} : { outputTokens: Number(row.output_tokens) }),
  ...(complete ? { costUsd: Number(row!.cost) } : {}), ...(prefixComplete ? { totalCostUsd: Number(row!.total_cost) } : {}) };
}
