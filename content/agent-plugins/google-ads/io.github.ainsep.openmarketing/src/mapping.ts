import type { Hierarchy, SearchPlan } from "./types.ts";
import { googleDateTime } from "./rules.ts";

/** Atomic parent-first creation, partialFailure=false, every serving entity PAUSED.
 * Only validated Search plans reach this mapper. @complexity O(k+g), k<=50,g<=20. */
export function createOperations(required: { customerId: string; plan: SearchPlan; marker: string; timezone: string }): Record<string, unknown>[] {
  const { customerId, plan, marker, timezone } = required;
  const budget = `customers/${customerId}/campaignBudgets/-1`;
  const campaign = `customers/${customerId}/campaigns/-2`;
  const group = `customers/${customerId}/adGroups/-3`;
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: marker + "-budget", amountMicros: plan.averageDailyBudgetMicros, period: "DAILY", deliveryMethod: "STANDARD", explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name: marker, status: "PAUSED", advertisingChannelType: "SEARCH", campaignBudget: budget,
      manualCpc: {}, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      containsEuPoliticalAdvertising: plan.euPoliticalAdvertising,
      startDateTime: googleDateTime({ epoch: plan.startsAt, timezone }), endDateTime: googleDateTime({ epoch: plan.endsAt, timezone }),
      geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" },
    } } },
    { adGroupOperation: { create: { resourceName: group, campaign, name: marker + "-group", status: "PAUSED", type: "SEARCH_STANDARD", cpcBidMicros: plan.cpcBidMicros } } },
    ...plan.geoTargetIds.map(target => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: "geoTargetConstants/" + target } } } })),
    ...plan.keywords.map(keyword => ({ adGroupCriterionOperation: { create: { adGroup: group, status: "PAUSED", keyword, negative: false } } })),
    { adGroupAdOperation: { create: { adGroup: group, status: "PAUSED", ad: { finalUrls: [plan.finalUrl], responsiveSearchAd: { headlines: plan.headlines.map(text => ({ text })), descriptions: plan.descriptions.map(text => ({ text })) } } } } },
  ];
}
/** The only editable fields are status and a non-shared average daily budget. */
export function statusOperations(required: { hierarchy: Hierarchy; status: "PAUSED" | "ENABLED" }): Record<string, unknown>[] {
  const { hierarchy, status } = required;
  const root = "customers/" + hierarchy.customerId;
  return [
    { campaignOperation: { update: { resourceName: root + "/campaigns/" + hierarchy.campaignId, status }, updateMask: "status" } },
    ...hierarchy.childIds.map(id => childStatus({ id, root, status })),
  ];
}
function childStatus(required: { id: string; root: string; status: string }): Record<string, unknown> {
  const { id, root, status } = required;
  const [kind, resourceId] = id.split(":");
  if (kind === "group") return { adGroupOperation: { update: { resourceName: root + "/adGroups/" + resourceId, status }, updateMask: "status" } };
  if (kind === "keyword") return { adGroupCriterionOperation: { update: { resourceName: root + "/adGroupCriteria/" + resourceId, status }, updateMask: "status" } };
  return { adGroupAdOperation: { update: { resourceName: root + "/adGroupAds/" + resourceId, status }, updateMask: "status" } };
}
/** Budget mutation never switches period, shares budget, or mutates another account. */
export function budgetOperations(required: { hierarchy: Hierarchy; averageDailyBudgetMicros: string }): Record<string, unknown>[] {
  return [{ campaignBudgetOperation: { update: { resourceName: `customers/${required.hierarchy.customerId}/campaignBudgets/${required.hierarchy.budgetId}`, amountMicros: required.averageDailyBudgetMicros }, updateMask: "amount_micros" } }];
}
