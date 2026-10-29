import type { Hierarchy, SearchPlan } from "./types.ts";
import { googleDateTime, objectiveGoal } from "./rules.ts";

/** Atomic parent-first creation, partialFailure=false, every serving entity PAUSED.
 * Every observed goal is explicitly set for optimized bidding; unrelated defaults are disabled.
 * Only validated Search plans reach this mapper. @complexity O(k+g+c+a), k<=50,g<=200,c<=200,a<=3 ads. */
export function createOperations(required: { customerId: string; plan: SearchPlan; marker: string; timezone: string; conversionGoals: { category: string; origin: string }[] }): Record<string, unknown>[] {
  const { customerId, plan, marker, timezone } = required;
  const budget = `customers/${customerId}/campaignBudgets/-1`;
  const campaign = `customers/${customerId}/campaigns/-2`;
  const group = `customers/${customerId}/adGroups/-3`;
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: marker + "-budget", amountMicros: plan.averageDailyBudgetMicros, period: "DAILY", deliveryMethod: "STANDARD", explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name: marker, status: "PAUSED", advertisingChannelType: "SEARCH", campaignBudget: budget,
      ...(plan.objective ? { [objectiveGoal[plan.objective].field]: {} } : { manualCpc: {} }),
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      containsEuPoliticalAdvertising: plan.euPoliticalAdvertising,
      startDateTime: googleDateTime({ epoch: plan.startsAt, timezone }), endDateTime: googleDateTime({ epoch: plan.endsAt, timezone }),
      geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" },
    } } },
    { adGroupOperation: { create: { resourceName: group, campaign, name: marker + "-group", status: "PAUSED", type: "SEARCH_STANDARD", ...(plan.cpcBidMicros === undefined ? {} : { cpcBidMicros: plan.cpcBidMicros }) } } },
    ...(plan.proximity ? [{ campaignCriterionOperation: { create: { campaign, proximity: {
      geoPoint: { latitudeInMicroDegrees: plan.proximity.latitudeMicroDegrees, longitudeInMicroDegrees: plan.proximity.longitudeMicroDegrees },
      radius: plan.proximity.radiusKm, radiusUnits: "KILOMETERS",
    } } } }] : plan.geoTargetIds.map(target => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: "geoTargetConstants/" + target } } } }))),
    ...plan.keywords.map(keyword => ({ adGroupCriterionOperation: { create: { adGroup: group, status: "PAUSED", keyword, negative: false } } })),
    ...[plan, ...(plan.additionalAds ?? [])].map(ad => ({ adGroupAdOperation: { create: { adGroup: group, status: "PAUSED", ad: { finalUrls: [ad.finalUrl], responsiveSearchAd: { headlines: ad.headlines.map(text => ({ text })), descriptions: ad.descriptions.map(text => ({ text })) } } } } })),
    ...(plan.objective ? required.conversionGoals.map(goal => ({ campaignConversionGoalOperation: {
      update: { resourceName: `customers/${customerId}/campaignConversionGoals/-2~${goal.category}~${goal.origin}`,
        biddable: goal.category === objectiveGoal[plan.objective!].category && goal.origin === objectiveGoal[plan.objective!].origin },
      updateMask: "biddable",
    } })) : []),
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
