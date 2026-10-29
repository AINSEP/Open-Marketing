import { createGooglePlugin } from "../src/plugin.ts";
import { createFixtureDependencies, createFixtureTransport, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { createGoogleRestTransport } from "../src/transport.ts";
import { failure, success } from "../src/schema.ts";
import type { GooglePlugin } from "../src/plugin.ts";
import type { SearchPlan } from "../src/types.ts";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CampaignDeploymentRequired, Outcome } from "@open-marketing/contracts";

export const plan: SearchPlan = {
  name: "Fixture Search", currency: "USD", averageDailyBudgetMicros: "10000000", cpcBidMicros: "1000000",
  startsAt: fixtureTime, endsAt: fixtureTime + 2 * 86400000, geoTargetIds: ["2840"],
  keywords: [{ text: "marketing tools", matchType: "EXACT" }],
  headlines: ["Open Marketing", "Plan Search Campaigns", "See Clear Reports"],
  descriptions: ["Plan bounded Search campaigns.", "Review every exact spend operation."],
  finalUrl: "https://example.test/landing", euPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
};
export interface Harness { plugin: Pick<GooglePlugin, "invoke">; close(): Promise<void> }
export async function memoryHarness(): Promise<Harness> {
  return { plugin: createGooglePlugin(createFixtureDependencies({})), async close() {} };
}
/** Real REST codec with an injected local fixture HTTP service; no vendor/network I/O. */
export async function restHarness(): Promise<Harness> {
  const fixture = createFixtureTransport({});
  const dependencies = createFixtureDependencies({});
  const transport = createGoogleRestTransport({ binding: dependencies.binding,
    credentials: { async access() { return success({ value: { accessToken: "fixture-token-never-real" } }); } },
    http: { async post(input) {
      const method = input.url.endsWith("googleAds:search") ? "search" : "mutate";
      const response = await fixture.transport.request({ method, body: JSON.parse(input.body), context: input.context, operationId: input.operationId });
      if (!response.ok) return response;
      return success({ value: { status: 200, body: response.value } });
    } },
  });
  return { plugin: createGooglePlugin({ ...dependencies, transport }), async close() {} };
}
export function value<T>(required: { outcome: Outcome<unknown> }): T {
  if (!required.outcome.ok) throw new Error(required.outcome.error.code + ": " + required.outcome.error.message);
  return required.outcome.value as T;
}

/** Real hosted factory dependencies with fixture-only Google REST and owning-job checkpoints. */
export function hostedDeploymentFixture() {
  const fixture = createFixtureTransport({});
  const { binding, clock } = createFixtureDependencies({});
  const calls: { method: "search" | "mutate"; body: Record<string, unknown> }[] = [];
  const checkpoints: Parameters<CampaignDeploymentRequired["checkpoint"]>[0][] = [];
  const state = { failObservation: false };
  const required: CampaignDeploymentRequired = { context: fixtureContext, operationId: "hosted-launch", plan,
    connectionId: binding.connectionId, accountId: binding.customerId, saved: { references: {}, record: null },
    checkpoint: async input => {
      checkpoints.push(structuredClone(input));
      if (input.phase === "observation" && state.failObservation) return failure({ code: "unavailable", message: "Fixture checkpoint failure" });
      required.saved.record = structuredClone(input.record);
      return success({ value: undefined });
    },
    dependencies: { configuration: pluginConfigurationSchema.parse({ scope: binding.scope, connectionId: binding.connectionId, accountId: binding.customerId, pluginDigest: binding.pluginDigest, settings: {} }),
      clock, observer: { observe() {} }, wait: async () => success({ value: undefined }),
      credentials: { access: async () => success({ value: { accessToken: "fixture", secrets: { developerToken: "a".repeat(22) } } }) },
      fetch: async (url, init) => {
        const method = String(url).endsWith("googleAds:mutate") ? "mutate" : "search";
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ method, body });
        if (body.query === "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2") return Response.json({ results: [{ customer: { id: binding.customerId, currencyCode: binding.currency, timeZone: binding.timezone } }] });
        const result = await fixture.transport.request({ method, body, context: fixtureContext, operationId: required.operationId });
        if (!result.ok) return Response.json({}, { status: 503 });
        if (method === "search") return Response.json(result.value);
        const paths: Record<string, string> = { campaignBudgetOperation: "campaignBudgets/101", campaignOperation: "campaigns/201",
          adGroupOperation: "adGroups/301", campaignCriterionOperation: "campaignCriteria/201~2840", adGroupCriterionOperation: "adGroupCriteria/301~501" };
        let nextAdId = 401;
        return Response.json({ mutateOperationResponses: (body.mutateOperations as Record<string, unknown>[]).map(operation => {
          const kind = Object.keys(operation)[0];
          const path = kind === "adGroupAdOperation" ? "adGroupAds/301~" + nextAdId++ : paths[kind];
          return path ? { [kind.replace("Operation", "Result")]: { resourceName: `customers/${binding.customerId}/${path}` } } : {};
        }) });
      },
    },
  };
  return { required, state, calls, checkpoints, writes: fixture.writes };
}
