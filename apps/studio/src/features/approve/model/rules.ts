import { z } from "zod";
import { confirmationCardSchema, moneySchema, parseBoundary } from "@open-marketing/contracts";
import type { ApprovalResponse, ConfirmationCard, Outcome } from "@open-marketing/contracts";
import { isSafeUiValue } from "../../../shared/api/index.js";

function denied<T>(): Outcome<T> { return { ok: false, error: { code: "forbidden", message: "Card is unavailable, expired, or does not permit this choice", retryable: false } }; }
/** Reject unsafe display data intact. Client checks add friction and never grant authority. */
export function readApprovalCard(required: { input: unknown }): Outcome<ConfirmationCard> {
  if (!isSafeUiValue({ value: required.input, maxCharacters: 131072 })) return denied();
  const parsed = parseBoundary({ schema: confirmationCardSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const card = parsed.value;
  if (["spend", "destructive"].includes(card.classification) && card.allowedChoices.some(choice => isBroadChoice({ choice }))) return denied();
  return parsed;
}
function isBroadChoice(required: { choice: string }): boolean { return required.choice === "always_allow" || required.choice === "allow_chat"; }
/** Echo the immutable identifiers/digest and only a server-offered choice; never reconstruct arguments.
 * @example prepareApproval({ card, choice: "allow", now })
 * @complexity O(card bytes), bounded to 131072 characters including the card envelope.
 */
export function prepareApproval(required: { card: unknown; choice: ApprovalResponse["choice"]; now: number }): Outcome<ApprovalResponse> {
  const parsed = readApprovalCard({ input: required.card });
  if (!parsed.ok) return parsed;
  const card = parsed.value;
  if (required.now >= card.expiresAt || !card.allowedChoices.includes(required.choice)) return denied();
  return { ok: true, value: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: required.choice } };
}

const groupedLaunchSchema = z.object({ tool: z.literal('om_campaign_deploy_paused'), campaign: z.object({
  name: z.string().min(1).max(200), objective: z.literal('traffic'),
  schedule: z.object({ window: z.object({ start: z.number().int().nonnegative().max(8640000000000000), end: z.number().int().nonnegative().max(8640000000000000) }), timezone: z.string().min(1).max(100) }),
  creativeIds: z.array(z.string().max(256)).min(1).max(20),
  targets: z.array(z.object({ pluginId: z.string().max(256), connectionId: z.string().max(256), accountId: z.string().max(256), dailyBudget: moneySchema, expectedExposure: moneySchema })).min(1).max(4),
}), calls: z.array(z.unknown()).min(1).max(4) });
export interface LaunchDestinationSummary { readonly key: string; readonly vendor: string; readonly account: string; readonly budget: string; readonly exposure: string }
/** Display an optional grouped summary without replacing or altering the complete frozen arguments.
 * Invalid/oversized/secret-bearing cards yield no summary and remain subject to readApprovalCard.
 * @example useLaunchSummary({ card });
 * @complexity O(b) validation (b <=128 KiB); at most four destinations, no I/O.
 */
export function useLaunchSummary(required: { card: unknown }) {
  const card = readApprovalCard({ input: required.card });
  if (!card.ok) return null;
  const parsed = groupedLaunchSchema.safeParse(card.value.arguments);
  if (!parsed.success) return null;
  const { campaign, calls } = parsed.data;
  return { name: campaign.name, objective: campaign.objective, creatives: campaign.creativeIds.join(', '),
    schedule: new Date(campaign.schedule.window.start).toISOString() + ' → ' + new Date(campaign.schedule.window.end).toISOString() + ' · ' + campaign.schedule.timezone,
    callCount: calls.length, expires: card.value.expiresAt <= 8640000000000000 ? new Date(card.value.expiresAt).toISOString() : String(card.value.expiresAt),
    destinations: campaign.targets.map((target, index) => ({ key: String(index), vendor: target.pluginId, account: target.connectionId + ' / ' + target.accountId,
      budget: summaryMoney({ money: target.dailyBudget }), exposure: summaryMoney({ money: target.expectedExposure }) })),
  };
}
/** Currency units are formatted independently; never combine destinations or imply a spending cap. */
function summaryMoney(required: { money: { currency: string; minorUnits: number } }): string {
  try {
    const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: required.money.currency });
    return format.format(required.money.minorUnits / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return required.money.minorUnits + ' minor units ' + required.money.currency; }
}
