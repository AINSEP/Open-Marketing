import type { AgentEvent } from '@jini-ai/chat';
import type { AssistantUsage } from '@open-marketing/contracts';

/** Fixture values only; callers must opt into sample presentation explicitly. */
export const sampleReplyUsage = { kind: 'usage', durationMs: 8000, costUsdMicros: '70000', complete: true, costBasis: 'estimated' } as const;

/** Jini owns cost/time formatting; keep CB1's estimate/partial provenance visible beside it.
 * Jini 0.6.12 AgentEvent.costUsd is float display dollars; this is OM's only micros→dollars conversion.
 * @complexity O(1). Pure DTO conversion; unknown prices remain absent, never zero-filled.
 */
export function usageEvents(required: { usage: AssistantUsage; sample?: boolean }): AgentEvent[] {
  const { usage } = required;
  const events: AgentEvent[] = [{ kind: 'usage', durationMs: usage.durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(usage.costBasis === 'estimated' && usage.costUsdMicros !== undefined ? { costUsd: Number(usage.costUsdMicros) / 1e6 } : {}) }];
  if (required.sample || usage.costBasis === 'estimated' || !usage.complete) events.push({ kind: 'ext', name: required.sample ? 'om.sample-usage' : 'om.usage-evidence', data: {} });
  return events;
}
