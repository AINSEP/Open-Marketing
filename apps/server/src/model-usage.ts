/** Server-owned request evidence. No agent-supplied number can establish a charge. */
import { sql } from 'kysely';
import type { StorageKernel } from '@jini-ai/db/kernel';
import type { AssistantUsage, ModelProvider, RunGrantMetadata } from '@open-marketing/contracts';
import { decimalToMicros } from '@open-marketing/contracts';
import type { CampaignSqlPort } from '@open-marketing/campaigns';
import type { RequestUsage } from './model-protocols.js';

type Pricing = ModelProvider['models'][number]['pricing'];
/** Convert only consumed categories; missing rates stay unknown rather than becoming free. */
function pricedTokens(required: { tokens: number; rate?: string }): bigint | undefined {
 if (required.tokens === 0) return 0n;
 if (required.rate === undefined) return undefined;
 const rate = decimalToMicros({ value: required.rate, rounding: 'reject' });
 return rate.ok ? BigInt(rate.value) * BigInt(required.tokens) : undefined;
}
/** Declared decimal rates and normalized inclusive totals; half-even rounding once per request.
 * @example requestEstimate({ pricing: model.pricing, usage });
 * @complexity O(1) exact integer arithmetic; no I/O or protocol assumptions.
 */
export function requestEstimate(required: { pricing?: Pricing; usage: RequestUsage }): string | undefined {
 const { usage, pricing } = required;
 if (!pricing || usage.unpriced || usage.input === undefined || usage.output === undefined) return undefined;
 const uncached = usage.input - usage.cachedRead - usage.cacheWrite['5m'] - usage.cacheWrite['1h'];
 if (uncached < 0) return undefined;
 const costs = [pricedTokens({ tokens: uncached, rate: pricing.inputUsdPerMTok }),
  pricedTokens({ tokens: usage.output, rate: pricing.outputUsdPerMTok }),
  pricedTokens({ tokens: usage.cachedRead, rate: pricing.cachedInputUsdPerMTok }),
  pricedTokens({ tokens: usage.cacheWrite['5m'], rate: pricing.cacheWriteUsdPerMTok?.['5m'] }),
  pricedTokens({ tokens: usage.cacheWrite['1h'], rate: pricing.cacheWriteUsdPerMTok?.['1h'] })];
 if (costs.some(cost => cost === undefined)) return undefined;
 const weighted = (costs as bigint[]).reduce((sum, cost) => sum + cost, 0n);
 const cost = decimalToMicros({ value: `${weighted}e-12`, rounding: 'half_even' });
 return cost.ok ? cost.value : undefined;
}
/** Append intent before egress and at most one completion after EOF. No updates/deletes/retries.
 * An absent completion proves an unknown outcome after interruption or process loss. O(1) write.
 */
export async function appendUsage(required: { db: CampaignSqlPort; grant: RunGrantMetadata; requestId: string; kind: 'intent' | 'completion'; provider: string; model: string; now: number; pricing?: Pricing; usage?: RequestUsage }): Promise<void> {
 const cost = required.usage?.stopped ? requestEstimate({ pricing: required.pricing, usage: required.usage }) : undefined;
 const { source, observedOn, ...rates } = required.pricing ?? {};
 const written = await required.db.query({ text: 'INSERT INTO om_model_usage(request_id,kind,run_id,owner_id,workspace_id,recorded_at,input_tokens,output_tokens,cost_usd,evidence_json) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE $2=\'completion\' OR (SELECT COUNT(*) FROM om_model_usage WHERE run_id=$3 AND owner_id=$4 AND workspace_id=$5 AND kind=\'intent\')<25',
  values: [required.requestId, required.kind, required.grant.runId, required.grant.scope.ownerId, required.grant.scope.workspaceId, required.now,
   required.usage?.input ?? null, required.usage?.output ?? null, null,
   JSON.stringify({ provider: required.provider, model: required.model, source, observedOn, rates: required.pricing && rates, usage: required.usage, costUsdMicros: cost })] });
 if (written.rowCount !== 1) throw new Error('Model request limit reached');
}
/** One grouped SQL read across the conversation prefix, independent of history pagination.
 * Missing intents, receipts, or micros prices suppress cost for that turn and every later total.
 * The supplied kernel joins event persistence's transaction; no second pool lease is acquired.
 * @complexity O(r) indexed receipt aggregation for r requests; returns one summary row.
 */
export async function readUsage(required: { kernel: Pick<StorageKernel<unknown>, 'query'>; runId: string; ownerId: string; workspaceId: string }): Promise<AssistantUsage> {
 const rows = await required.kernel.query(sql<Record<string, unknown>>`WITH turns AS (
 SELECT r.run_id, COUNT(CASE WHEN u.kind='intent' THEN 1 END) AS intents,
 COUNT(CASE WHEN u.kind='completion' THEN 1 END) AS receipts, COUNT(json_extract(u.evidence_json,'$.costUsdMicros')) AS priced,
 SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(CAST(json_extract(u.evidence_json,'$.costUsdMicros') AS INTEGER)) AS cost, m.ended_at-COALESCE(m.started_at,m.created_at) AS duration
 FROM om_assistant_runs r JOIN ai_chat_messages m ON m.id=r.message_id
 LEFT JOIN om_model_usage u ON u.run_id=r.run_id AND u.owner_id=r.owner_id AND u.workspace_id=r.workspace_id
 WHERE r.owner_id=${required.ownerId} AND r.workspace_id=${required.workspaceId} AND r.conversation_id=(SELECT conversation_id FROM om_assistant_runs WHERE run_id=${required.runId} AND owner_id=${required.ownerId} AND workspace_id=${required.workspaceId})
 AND m.position <= (SELECT position FROM ai_chat_messages WHERE run_id=${required.runId} AND role='assistant')
 AND r.settings_json LIKE '%"mode":"model"%' GROUP BY r.run_id,m.ended_at,m.started_at,m.created_at
 ), summaries AS (SELECT *, CASE WHEN intents>0 AND intents=receipts AND receipts=priced THEN 1 ELSE 0 END AS complete FROM turns)
 SELECT MAX(CASE WHEN run_id=${required.runId} THEN complete ELSE 0 END) AS complete,
 MAX(CASE WHEN run_id=${required.runId} THEN input_tokens END) AS input_tokens, MAX(CASE WHEN run_id=${required.runId} THEN output_tokens END) AS output_tokens,
 CAST(MAX(CASE WHEN run_id=${required.runId} THEN cost END) AS TEXT) AS cost, MAX(CASE WHEN run_id=${required.runId} THEN duration END) AS duration, MIN(complete) AS prefix_complete, CAST(SUM(cost) AS TEXT) AS total_cost FROM summaries`);
 const row = rows[0];
 const complete = Number(row?.complete) === 1;
 const prefixComplete = Number(row?.prefix_complete) === 1;
 return { kind: 'usage', complete: complete && prefixComplete, ...(row?.duration == null ? {} : { durationMs: Math.max(0, Number(row.duration)) }), costBasis: complete ? 'estimated' : 'unavailable',
  ...(row?.input_tokens == null ? {} : { inputTokens: Number(row.input_tokens) }), ...(row?.output_tokens == null ? {} : { outputTokens: Number(row.output_tokens) }),
  ...(complete ? { costUsdMicros: String(row!.cost) } : {}), ...(prefixComplete ? { totalCostUsdMicros: String(row!.total_cost) } : {}) };
}
