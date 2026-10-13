import { describe, expect, it } from "vitest";
import { createCampaignService, createMemoryCampaignObserver } from "../../index.js";
import { context, fixture, flight, value } from "../fixtures.js";

describe("campaign observability", () => {
  it("propagates IDs and isolates observer capacity failure from successful operations", async () => {
    const env = await fixture();
    const observer = createMemoryCampaignObserver({ maxEntries: 1 });
    const service = createCampaignService(env, { observer });
    const saved = value({ outcome: await service.createPaused({ context, draft: env.draft }) });
    expect(saved.observedState).toBe("paused");
    expect(observer.events({})).toEqual([{ operation: "campaigns.createPaused", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    expect(value({ outcome: await service.proposeLaunch({ context, campaignId: saved.campaignId, flight }) }).operations).toHaveLength(1);
    expect(observer.events({})).toHaveLength(1);
  });
  it("rejects invalid observer configuration/events without retaining tainted evidence", () => {
    expect(() => createMemoryCampaignObserver({ maxEntries: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    const observer = createMemoryCampaignObserver({});
    expect(() => observer.observe({ operation: "op", outcome: "unknown", correlationId: "correlation", traceId: "" })).toThrow(TypeError);
    expect(observer.events({})).toEqual([]);
  });
});
