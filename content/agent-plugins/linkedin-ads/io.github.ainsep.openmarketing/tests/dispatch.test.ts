import { createLinkedInAdsAdapter } from "../src/transport.js";
import { describe, expect, it, vi } from "vitest";
import type { LinkedInInvocation } from "../src/ports.js";
import { analyticsPage, approve, campaign, campaignPage, configuration, conversionPage, conversionRule, creativePage, fixture, groupPage, invocation, leadPage, now, reportCommand } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "Memory host with real plugin fetch adapter", makeFixture: () => fixture() });

describe("fenced LinkedIn transport", () => {
  it("rechecks host authority after credential resolution and prevents egress on revocation", async () => {
    const f = fixture({ credentialHook: () => { f.state.writeAllowed = false; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toHaveLength(0);
  });
  it("returns a spend acknowledgement only for the exact reviewed request and requires a new card", async () => {
    const f = fixture({ response: () => new Response(null, { status: 204 }) });
    const request = invocation({ command: { kind: "activate", entityType: "creative", entityId: "678" }, operationId: "creative-activation" });
    const wire = { url: "https://api.linkedin.com/rest/adAccounts/123/creatives/urn%3Ali%3AsponsoredCreative%3A678", method: "POST", restliMethod: "PARTIAL_UPDATE", body: '{"patch":{"$set":{"intendedStatus":"ACTIVE"}}}' };
    approve({ fixture: f, request, wire });
    expect(await f.adapter.invoke(request)).toEqual({ ok: true, value: { operationId: "creative-activation", status: "acknowledged", observedState: "unknown", data: null } });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].init.body).toBe(wire.body);
    expect(await f.adapter.invoke({ ...request, operationId: "second-activation" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(1);
    expect(f.effects[0]).toMatchObject({ moneyExposure: request.moneyExposure, requiredLimit: request.requiredLimit });
  });
  it("maps set_budget to a single spend patch and rejects drift against its card", async () => {
    const f = fixture({ response: () => new Response(null, { status: 204 }) });
    const request = invocation({ command: { kind: "set_budget", campaignId: "567", dailyBudget: { amount: "54.32", currencyCode: "USD" } } });
    approve({ fixture: f, request, wire: { url: "https://api.linkedin.com/rest/adAccounts/123/adCampaigns/567", method: "POST", restliMethod: "PARTIAL_UPDATE", body: '{"patch":{"$set":{"dailyBudget":{"amount":"54.32","currencyCode":"USD"}}}}' } });
    expect(await f.adapter.invoke(request)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(f.calls[0].init.body).toBe('{"patch":{"$set":{"dailyBudget":{"amount":"54.32","currencyCode":"USD"}}}}');
    const changed = { ...request, command: { kind: "set_budget" as const, campaignId: "567", dailyBudget: { amount: "99", currencyCode: "USD" } } };
    expect(await f.adapter.invoke(changed)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(1);
  });
  it("keeps exact serialized arguments when the caller changes input during credential resolution", async () => {
    const request = invocation();
    const f = fixture({ credentialHook: () => { Object.assign(request.command, { name: "Changed while pending" }); } });
    expect(await f.adapter.invoke(request)).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(JSON.parse(String(f.calls[0].init.body)).name).toBe("Fixture group");
  });
  it.each([null, { accessToken: "secret\r\nInjected: true" }, { accessToken: "secret", expiresAt: now }, { accessToken: "secret", expiresAt: -1 }, { accessToken: "secret", extra: true }])("rejects malformed or expired token data", async credential => {
    const f = fixture({ credential });
    const outcome = await f.adapter.invoke(invocation());
    expect(outcome.ok).toBe(false); expect(f.calls).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });
  it("cancels after credential resolution and never reaches fetch", async () => {
    const controller = new AbortController();
    const f = fixture({ credentialHook: () => { controller.abort(); } });
    expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0);
  });
  it("marks a thrown/ambiguous write unknown, never retries or resends a claimed operation", async () => {
    const f = fixture({ response: () => { throw new Error("synthetic-secret vendor timeout"); } });
    expect(await f.adapter.invoke(invocation({ command: campaign }))).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(await f.adapter.invoke(invocation({ command: campaign }))).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.observations)).not.toContain("synthetic-secret");
  });
  it("cannot fetch twice even if a faulty gateway invokes execute twice", async () => {
    const f = fixture({ gateway: { async dispatch(input) { await input.execute(); return input.execute(); } } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each([400, 401, 403, 409, 429])("maps vendor %s into a sanitized non-retryable failure", async status => {
    const f = fixture({ response: () => new Response('{"message":"synthetic-secret"}', { status }) });
    const outcome = await f.adapter.invoke(invocation());
    expect(outcome).toMatchObject({ ok: false, error: { retryable: false } });
    expect(JSON.stringify(outcome)).not.toContain("synthetic-secret"); expect(f.calls).toHaveLength(1);
  });
  it.each([
    () => new Response(null, { status: 500 }),
    () => new Response("not JSON", { status: 201, headers: { "x-restli-id": "456" } }),
    () => new Response(null, { status: 201 }),
    () => new Response(null, { status: 201, headers: { "x-restli-id": "not-an-id" } }),
    () => new Response("x".repeat(1048577), { status: 201, headers: { "x-restli-id": "456" } }),
  ])("keeps malformed and oversized write receipts unknown", async response => {
    const f = fixture({ response });
    expect(await f.adapter.invoke(invocation({ command: campaign }))).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
  });
  it("enforces a 15s cancellation signal with redirects disabled", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const f = fixture();
      await f.adapter.invoke(invocation());
      expect(f.calls[0].init.redirect).toBe("error");
      expect(f.calls[0].init.headers).toEqual({ Authorization: "Bearer synthetic-secret", "LinkedIn-Version": "202610", "X-Restli-Protocol-Version": "2.0.0", "X-RestLi-Method": "CREATE", "Content-Type": "application/json" });
      expect(f.calls[0].init.signal?.aborted).toBe(false);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15000);
      expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    } finally { timeout.mockRestore(); }
  });
  it("keeps telemetry failure from changing an acknowledged campaign outcome", async () => {
    const f = fixture({ observerThrows: true });
    expect(await f.adapter.invoke(invocation({ command: campaign }))).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  });
  it.each([
    { moneyExposure: null }, { requiredLimit: null },
    { moneyExposure: { amount: { currency: "EUR", minorUnits: 1 }, window: { start: now, end: now + 1000 } } },
  ])("rejects incomplete or wrong-currency canonical spend metadata", async fields => {
    const f = fixture();
    expect(await f.adapter.invoke({ ...invocation({ command: { kind: "activate", entityType: "campaign", entityId: "567" } }), ...fields })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("returns sanitized credential and pre-egress gateway failures", async () => {
    const f = fixture();
    const credentials = { async access() { throw new Error("synthetic-secret"); } };
    const adapter = createLinkedInAdsAdapter({ ...f.dependencies, credentials });
    expect(await adapter.invoke(invocation())).toEqual({ ok: false, error: { code: "unavailable", message: "LinkedIn request unavailable", retryable: false } });
    const gatewayFailure = fixture({ gateway: { async dispatch() { throw new Error("synthetic-secret"); } } });
    expect(await gatewayFailure.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toHaveLength(0); expect(gatewayFailure.calls).toHaveLength(0);
  });
  it("validates configuration and cyclic inputs before any I/O", async () => {
    const f = fixture();
    const adapter = createLinkedInAdsAdapter({ ...f.dependencies, configuration: { ...configuration, apiVersion: "202609" as "202610" } });
    expect(await adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const input = invocation(); Object.assign(input, { cycle: input });
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("preserves caller cancellation during a write as unknown once fetch starts", async () => {
    const controller = new AbortController();
    const f = fixture();
    const fetchPort: typeof fetch = async (_url, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("fixture cancellation after egress");
    };
    const adapter = createLinkedInAdsAdapter({ ...f.dependencies, fetch: fetchPort });
    expect(await adapter.invoke(invocation({ command: campaign }), { signal: controller.signal })).toMatchObject({ ok: true, value: { status: "unknown" } });
  });
});

describe("LinkedIn analytics and conversion setup dispatch", () => {
  it("returns source-labelled decimal spend and UTC exclusive end without leaking provider additions", async () => {
    const f = fixture({ response: () => Response.json({ ...analyticsPage, paging: { links: [{ href: "https://untrusted.example" }] }, secret: "synthetic-secret" }) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", observedState: "unknown", data: { source: "linkedin_ad_analytics", apiVersion: "202610", accountId: "123", currency: "USD", retrievedAt: now, window: reportCommand.window, availability: "reported", rows: [{ entityUrn: "urn:li:sponsoredAccount:123", window: reportCommand.window, spend: "123456789.123456789", impressions: 123, clicks: 4 }] } } });
    expect(f.calls).toHaveLength(1);
    expect(f.effects[0].effects).toEqual(["read"]);
  });
  it("does not interpret an empty report as zero spend or confirmed access", async () => {
    const f = fixture({ response: () => Response.json({ elements: [] }) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { availability: "no_data_access_unconfirmed", rows: [] } } });
  });
  it("decodes a leap-day inclusive period and preserves exact campaign attribution", async () => {
    const start = Date.UTC(2024, 1, 29);
    const command = { kind: "report" as const, pivot: "CAMPAIGN" as const, campaignIds: ["567"], window: { start, end: Date.UTC(2024, 2, 1) } };
    const row = { ...analyticsPage.elements[0], pivotValues: ["urn:li:sponsoredCampaign:567"], dateRange: { start: { year: 2024, month: 2, day: 29 }, end: { year: 2024, month: 2, day: 29 } } };
    const f = fixture({ response: () => Response.json({ elements: [row] }) });
    expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: true, value: { data: { rows: [{ entityUrn: "urn:li:sponsoredCampaign:567", window: command.window }] } } });
    expect(f.calls[0].url).toContain("end:(year:2024,month:2,day:29)");
  });
  it.each([
    { elements: [{ ...analyticsPage.elements[0], costInLocalCurrency: 0.1 }] },
    { elements: [{ ...analyticsPage.elements[0], costInLocalCurrency: "1e6" }] },
    { elements: [{ ...analyticsPage.elements[0], impressions: Number.MAX_SAFE_INTEGER + 1 }] },
    { elements: [{ ...analyticsPage.elements[0], clicks: -1 }] },
    { elements: [{ ...analyticsPage.elements[0], pivotValues: ["urn:li:sponsoredAccount:456"] }] },
    { elements: [...analyticsPage.elements, { ...analyticsPage.elements[0], pivotValues: ["urn:li:sponsoredAccount:456"] }] },
    { elements: [...analyticsPage.elements, ...analyticsPage.elements] },
    { elements: Array.from({ length: 101 }, () => analyticsPage.elements[0]) },
    { elements: [{ ...analyticsPage.elements[0], dateRange: { start: { year: 2026, month: 2, day: 29 }, end: { year: 2026, month: 10, day: 13 } } }] },
    { elements: [{ ...analyticsPage.elements[0], dateRange: { start: { year: 2026, month: 10, day: 1 }, end: { year: 2026, month: 10, day: 13 } } }] },
  ])("rejects the whole malformed, duplicate, foreign or expanded analytics page", async page => {
    const f = fixture({ response: () => Response.json(page) });
    expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("rejects an unrequested campaign in a mixed analytics page", async () => {
    const f = fixture({ response: () => Response.json({ elements: ["567", "568"].map(id => ({ ...analyticsPage.elements[0], pivotValues: ["urn:li:sponsoredCampaign:" + id] })) }) });
    expect(await f.adapter.invoke(invocation({ command: { ...reportCommand, pivot: "CAMPAIGN", campaignIds: ["567"] } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("requires current write authority for rule creation and association", async () => {
    const f = fixture(); f.state.writeAllowed = false;
    for (const command of [conversionRule, { kind: "associate_conversion_rule" as const, campaignId: "567", conversionId: "789" }]) {
      expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(f.calls).toHaveLength(0);
  });
  it("acknowledges a created rule ID and a 204 compound association without claiming attribution", async () => {
    const create = fixture({ response: () => new Response(null, { status: 201, headers: { "x-restli-id": "789" } }) });
    expect(await create.adapter.invoke(invocation({ command: conversionRule }))).toMatchObject({ ok: true, value: { status: "acknowledged", data: { id: "789" }, observedState: "unknown" } });
    const associate = fixture({ response: () => new Response(null, { status: 204 }) });
    expect(await associate.adapter.invoke(invocation({ command: { kind: "associate_conversion_rule", campaignId: "567", conversionId: "789" } }))).toMatchObject({ ok: true, value: { status: "acknowledged", observedState: "unknown" } });
    expect(associate.calls[0].init.method).toBe("PUT");
    expect(new Headers(associate.calls[0].init.headers).get("X-RestLi-Method")).toBe("UPDATE");
  });
  it("lists only projected conversion-rule metadata bound to the account", async () => {
    const f = fixture({ response: () => Response.json({ elements: [{ ...conversionPage.elements[0], imagePixelTag: "synthetic-secret" }] }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_conversion_rules" } }))).toMatchObject({ ok: true, value: { data: { items: [{ ...conversionPage.elements[0], id: "789" }], nextPageToken: null } } });
  });
  it.each([
    { elements: [{ ...conversionPage.elements[0], account: "urn:li:sponsoredAccount:456" }] },
    { elements: [...conversionPage.elements, ...conversionPage.elements] },
    { elements: [{ ...conversionPage.elements[0], enabled: "true" }] },
    { elements: Array.from({ length: 101 }, () => conversionPage.elements[0]) },
  ])("rejects foreign, duplicate, oversized and malformed rule pages atomically", async page => {
    const f = fixture({ response: () => Response.json(page) });
    expect((await f.adapter.invoke(invocation({ command: { kind: "list_conversion_rules" } }))).ok).toBe(false);
  });
  it("lists form metadata with an explicit offset hint and strips all lead content and URLs", async () => {
    const f = fixture({ response: () => Response.json({ ...leadPage, elements: [{ ...leadPage.elements[0], content: { answers: "synthetic-secret" }, hiddenFields: ["synthetic-secret"] }] }) });
    const output = await f.adapter.invoke(invocation({ command: { kind: "list_lead_forms", count: 1 } }));
    expect(output).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", observedState: "unknown", data: { items: leadPage.elements, nextStart: 1 } } });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("synthetic-secret");
    expect(JSON.stringify(output)).not.toContain("https://");
  });
  it.each([
    { ...leadPage, elements: [{ ...leadPage.elements[0], owner: { sponsoredAccount: "urn:li:sponsoredAccount:456" } }] },
    { ...leadPage, elements: [...leadPage.elements, ...leadPage.elements], paging: { start: 0, count: 100 } },
    { ...leadPage, paging: { start: 1, count: 100 } },
    { ...leadPage, elements: [{ ...leadPage.elements[0], id: 6755260984438374400 }] },
    { ...leadPage, elements: [{ ...leadPage.elements[0], state: "UNKNOWN" }] },
  ])("rejects invalid/foreign/duplicate forms and pagination drift without partial output", async page => {
    const f = fixture({ response: () => Response.json(page) });
    expect((await f.adapter.invoke(invocation({ command: { kind: "list_lead_forms" } }))).ok).toBe(false);
  });
  it("returns no offset hint on a short or empty form page", async () => {
    const f = fixture({ response: () => Response.json({ elements: [], paging: { start: 0, count: 100 } }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_lead_forms" } }))).toMatchObject({ ok: true, value: { data: { items: [], nextStart: null } } });
  });
});

describe("validated provider readback", () => {
  it.each([
    { content: { reference: "urn:li:share:987" }, reference: "urn:li:share:987" },
    { content: { standardUpdateAd: { reference: "urn:li:share:987", contentAuthor: "urn:li:organization:789" } }, reference: "urn:li:share:987" },
    { content: { videoAd: { reference: "urn:li:ugcPost:987", contentAuthor: "urn:li:person:789", preRollMetadata: { ignored: true } } }, reference: "urn:li:ugcPost:987" },
    { content: { reference: "urn:li:share:987", standardUpdateAd: { reference: "urn:li:share:987" }, videoAd: { reference: "urn:li:share:987" } }, reference: "urn:li:share:987" },
  ])("normalizes legacy and enriched content while stripping provider additions: %j", async ({ content, reference }) => {
    const f = fixture({ response: () => Response.json({ elements: [{ ...creativePage.elements[0], content }] }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_creatives" } }))).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", observedState: "unknown", data: { items: [{ ...creativePage.elements[0], content: { reference } }], nextPageToken: null } } });
    expect(new Headers(f.calls[0].init.headers).get("LinkedIn-Version")).toBe("202610");
  });
  it.each([
    undefined, null, {}, { reference: "bad" }, { standardUpdateAd: {} }, { videoAd: { reference: 987 } },
    { reference: "urn:li:share:987", videoAd: null },
    { reference: "urn:li:share:987", standardUpdateAd: { reference: "urn:li:share:999" } },
    { standardUpdateAd: { reference: "urn:li:share:987" }, videoAd: { reference: "urn:li:share:999" } },
  ])("rejects a mixed page atomically when a creative reference is missing, malformed or conflicting: %j", async content => {
    const f = fixture({ response: () => Response.json({ elements: [creativePage.elements[0], { ...creativePage.elements[0], id: "urn:li:sponsoredCreative:679", content }] }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_creatives" } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    ["list_campaign_groups", groupPage, "456"], ["list_campaigns", campaignPage, "567"], ["list_creatives", creativePage, "urn:li:sponsoredCreative:678"],
  ])("returns source state through %s without promoting acknowledgement to observed hierarchy", async (kind, page, id) => {
    const f = fixture({ response: () => new Response(JSON.stringify(page)) });
    const command = { kind } as LinkedInInvocation["command"];
    const outcome = await f.adapter.invoke(invocation({ command }));
    expect(outcome).toMatchObject({ ok: true, value: { status: "succeeded", observedState: "unknown", data: { items: [{ id }] } } });
    expect(f.calls).toHaveLength(1);
  });
  it("returns opaque pagination and strips unrelated provider data and URLs", async () => {
    const page = { ...groupPage, elements: groupPage.elements.map(item => ({ ...item, accessToken: "synthetic-secret" })), paging: { links: [{ href: "https://foreign.example" }] } };
    const f = fixture({ response: () => new Response(JSON.stringify(page)) });
    const outcome = await f.adapter.invoke(invocation({ command: { kind: "list_campaign_groups" } }));
    expect(outcome).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", observedState: "unknown", data: { items: [{ id: "456", account: "urn:li:sponsoredAccount:123", name: "Fixture group", status: "DRAFT", totalBudget: { amount: "43.21", currencyCode: "USD" } }], nextPageToken: "next_page-1" } } });
    expect(f.calls).toHaveLength(1); expect(JSON.stringify(outcome)).not.toContain("foreign.example"); expect(JSON.stringify(outcome)).not.toContain("synthetic-secret");
  });
  it.each([
    { ...groupPage, elements: [{ ...groupPage.elements[0], account: "urn:li:sponsoredAccount:999" }] },
    { ...groupPage, elements: [...groupPage.elements, ...groupPage.elements] },
    { ...groupPage, elements: [{ ...groupPage.elements[0], id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...groupPage, elements: [{ ...groupPage.elements[0], status: "UNDOCUMENTED" }] },
    { ...groupPage, metadata: { nextPageToken: "x\r\ny" } },
    { elements: Array.from({ length: 101 }, (_, index) => ({ ...groupPage.elements[0], id: index + 1 })) },
  ])("rejects invalid aggregate provider pages atomically", async page => {
    const f = fixture({ response: () => new Response(JSON.stringify(page)) });
    expect((await f.adapter.invoke(invocation({ command: { kind: "list_campaign_groups" } }))).ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });
  it("validates requested IDs and page size against actual output", async () => {
    const f = fixture({ response: () => new Response(JSON.stringify(groupPage)) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaign_groups", ids: ["999"], pageSize: 1 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("validates targeting facet and returns only targeting schema fields", async () => {
    const f = fixture({ response: () => new Response(JSON.stringify({ elements: [{ urn: "urn:li:geo:103644278", facetUrn: "urn:li:adTargetingFacet:locations", name: "United States" }] })) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "search_targeting", facet: "locations", query: "United" } }))).toMatchObject({ ok: true, value: { data: { items: [{ name: "United States" }] } } });
    expect(await f.adapter.invoke(invocation({ command: { kind: "search_targeting", facet: "skills", query: "United" }, operationId: "different-facet" }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("returns unavailable for read transport loss while write uncertainty remains explicit", async () => {
    const f = fixture({ response: () => { throw new Error("fixture loss"); } });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("rejects oversized inputs before credentials", async () => {
    const f = fixture();
    const input = { ...invocation(), extra: "x".repeat(65536) } as LinkedInInvocation;
    expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("provides safe accounts and creative acknowledgements", async () => {
    const account = fixture({ response: () => new Response(JSON.stringify({ elements: [{ id: 123, name: "Fixture", status: "ACTIVE", currency: "USD", test: true }] })) });
    expect(await account.adapter.invoke(invocation({ command: { kind: "list_accounts" } }))).toMatchObject({ ok: true, value: { data: { items: [{ id: "123", currency: "USD" }] } } });
    const creative = fixture({ response: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:sponsoredCreative:678" } }) });
    expect(await creative.adapter.invoke(invocation({ command: { kind: "create_creative_paused", campaignId: "567", reference: "urn:li:share:987" } }))).toMatchObject({ ok: true, value: { status: "acknowledged", data: { id: "urn:li:sponsoredCreative:678" } } });
  });
});
