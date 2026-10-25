import { readApprovalCard } from '../../features/approve/index.js';
import { moneySchema } from '@open-marketing/contracts';

/** Summarize validated primitive context without reconstructing the authoritative arguments.
 * @complexity O(b) validation, b <=128 KiB; presentation reads at most four fields. No effects.
 */
export function approvalSummary(required: { card: unknown }): { title: string; description: string; argumentsText: string } {
  const parsed = readApprovalCard({ input: required.card });
  if (!parsed.ok) return { title: 'Approval unavailable', description: 'The server card could not be validated.', argumentsText: 'Invalid server card.' };
  const titles = { spend: 'Exact spend approval', destructive: 'Confirm destructive action', generation: 'Review generation', write: 'Review tool call' };
  const args = parsed.value.arguments;
  const description = summaryFields({ args });
  return { title: titles[parsed.value.classification], description: description || 'Review this exact request before allowing the server to proceed.', argumentsText: JSON.stringify(args, null, 2) };
}

/** Strings are text-only React content; the full frozen request stays in the shared card. */
function summaryFields(required: { args: Record<string, unknown> }): string {
  const text = ['tool', 'action', 'brief', 'campaignId', 'format'].map(key => required.args[key]).filter(isSummaryText).map(value => value.slice(0, 200));
  if (typeof required.args.count === 'number') text.push('Count: ' + required.args.count);
  const money = moneySchema.safeParse(required.args.quotedCost ?? required.args.exposure);
  if (money.success) text.push(summaryMoney(money.data));
  return text.join(' · ');
}
function isSummaryText(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

/** Currency exponent comes from Intl; a valid but unknown currency retains its exact minor units. */
function summaryMoney(required: { currency: string; minorUnits: number }): string {
  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: required.currency });
    return formatter.format(required.minorUnits / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return required.minorUnits + ' minor units ' + required.currency; }
}
