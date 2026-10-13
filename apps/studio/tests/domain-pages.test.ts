/** @vitest-environment jsdom */
import { afterEach, it, expect } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { WorkspaceCanvas } from "../src/widgets/workspace-canvas/index.js";
import { createSampleStudioApi, parseStudioSnapshot } from "../src/shared/api/index.js";
import type { StudioSnapshot } from "../src/shared/api/index.js";
import type { NavigationTarget } from "@open-marketing/contracts";
import { testRuntime } from "./support/runtime.js";

afterEach(cleanup);
/** Start from the real port boundary, not fixtures imported by a component. */
async function domainHost() {
  const timer = testRuntime(); const api = createSampleStudioApi({ runtime: timer.runtime });
  const result = await api.snapshot({});
  if (!result.ok) throw new Error("Sample snapshot rejected: " + result.error.message);
  return { snapshot: result.value, api, runtime: timer.runtime, onOpenChat() {} };
}
function show(required: { host: Awaited<ReturnType<typeof domainHost>>; target: NavigationTarget; snapshot?: StudioSnapshot }) {
  return render(createElement(WorkspaceCanvas, { ...required.host, target: required.target, snapshot: required.snapshot ?? required.host.snapshot }));
}
function pages(required: { snapshot: StudioSnapshot }): NonNullable<StudioSnapshot["pages"]> {
  if (!required.snapshot.pages) throw new Error("Domain fixtures missing");
  return required.snapshot.pages;
}
it("shows unavailable costs and preserves pending, failed and unknown generation evidence", async () => {
  const host = await domainHost(); show({ host, target: "creative" });
  const unknown = within(screen.getByRole("article", { name: "Window light" }));
  expect(unknown.getByText("Outcome: unknown")).toBeDefined();
  expect(unknown.getByText("Unavailable · not confirmed free")).toBeDefined();
  expect(unknown.getByText("Timed out; charge and output remain unknown. Await reconciliation.")).toBeDefined();
  expect(unknown.queryByText("$0.00")).toBeNull();
  const failed = within(screen.getByRole("article", { name: "Evening texture" }));
  expect(failed.getByText("Outcome: failed")).toBeDefined();
  expect(failed.getAllByText("$0.80")).toHaveLength(3);
  expect(failed.getByText("Generation failed after a recorded charge. No refund confirmed.")).toBeDefined();
  expect(within(screen.getByRole("article", { name: "Small details, big difference" })).getByText("Outcome: pending")).toBeDefined();
  expect(screen.getByRole("link", { name: "Inspect plugins" }).getAttribute("href")).toBe("#plugins");
});
it("shows the associated generation card choices without calculating allowance eligibility", async () => {
  const host = await domainHost(); show({ host, target: "creative" });
  const under = within(screen.getByRole("article", { name: "The morning ritual" }));
  expect(under.getByText("Within daily allowance · server assessment")).toBeDefined();
  expect(under.getByRole("button", { name: "Always allow" })).toBeDefined();
  for (const title of ["A complete launch collection", "A cinematic variation"]) {
    const card = within(screen.getByRole("article", { name: title }));
    expect(card.getByRole("button", { name: /^Allow$/ })).toBeDefined();
    expect(card.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(card.queryByRole("button", { name: "Allow for this chat" })).toBeNull();
  }
});
it("pairs a crop with its original and exposes dedupe, cost and provenance evidence", async () => {
  const host = await domainHost(); show({ host, target: "media-library" });
  const original = within(screen.getByRole("article", { name: "Morning light / original" }));
  const crop = within(screen.getByRole("article", { name: "Morning light / landscape crop" }));
  expect(crop.getByText("Morning light / original")).toBeDefined();
  expect(crop.getByText("Landscape placement · centered crop · original bytes preserved.")).toBeDefined();
  const user = userEvent.setup();
  await user.click(original.getByText("Provenance, cost and import evidence"));
  expect(original.getByText("Repeated import matched the content digest; reused this asset without duplicating cost.")).toBeDefined();
  expect(original.getByText("Actual charge recorded once on the original.")).toBeDefined();
  await user.click(crop.getByText("Provenance, cost and import evidence"));
  expect(crop.getByText("Rendition of asset-morning; inherits its rights and generation provenance.")).toBeDefined();
  expect(original.getByText("1600 × 1600")).toBeDefined();
  expect(crop.getByText("1200 × 628")).toBeDefined();
});
it("suppresses launch approval on blocked and unavailable reviews even when they reference a card", async () => {
  const host = await domainHost(); const data = pages({ snapshot: host.snapshot });
  const snapshot: StudioSnapshot = { ...host.snapshot, pages: { ...data, campaigns: { ...data.campaigns, drafts: data.campaigns.drafts.map(draft => ({ ...draft, approvalCardId: "sample-spend" })) } } };
  show({ host, target: "campaigns", snapshot });
  for (const title of ["A moment of discovery", "Weekend ritual"]) {
    const draft = within(screen.getByRole("article", { name: title }));
    expect(draft.queryByRole("button", { name: /^Allow$/ })).toBeNull();
    expect(draft.getByText("Launch approval unavailable · request a ready review and fresh exact card from the server.")).toBeDefined();
  }
  const blocked = within(screen.getByRole("article", { name: "A moment of discovery" }));
  expect(blocked.getByText("Cap evidence expired.")).toBeDefined();
  expect(blocked.getByText("Selected account is outside the workspace scope.")).toBeDefined();
  expect(blocked.getByText("Creative set needs rights review.")).toBeDefined();
  expect(within(screen.getByRole("article", { name: "The ritual starts here" })).getByRole("button", { name: /^Allow$/ })).toBeDefined();
});
it("records a campaign choice as acknowledgement and keeps the draft paused", async () => {
  const host = await domainHost(); const user = userEvent.setup(); show({ host, target: "campaigns" });
  const draft = within(screen.getByRole("article", { name: "The ritual starts here" }));
  await user.click(draft.getByRole("button", { name: /^Allow$/ }));
  expect(draft.getByText("Choice recorded in preview · no external call ran")).toBeDefined();
  expect(draft.getByText("paused · Review: ready")).toBeDefined();
  const result = await host.api.snapshot({}); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Snapshot unavailable");
  expect(result.value.pages?.campaigns.drafts.find(item => item.id === "spring-ritual")?.status).toBe("paused");
});
it("keeps local barriers distinct from pending, partial and unknown remote stops", async () => {
  const host = await domainHost(); show({ host, target: "campaigns" });
  for (const [account, remote] of [["Launch account", "pending"], ["Discovery account", "partial"], ["Regional account", "unknown"]]) {
    const receipt = within(screen.getByRole("article", { name: account }));
    expect(receipt.getByText("Local dispatch barrier")).toBeDefined();
    expect(receipt.getByText("blocked")).toBeDefined();
    expect(receipt.getByText("Remote stop")).toBeDefined();
    expect(receipt.getByText(remote)).toBeDefined();
  }
  expect(within(screen.getByRole("article", { name: "Launch account" })).getByText("Local dispatch is blocked. Remote pause requested; ads may still be serving.")).toBeDefined();
});
it("shows both daily defaults, server usage, timezone, reset and revision outcomes", async () => {
  const host = await domainHost(); show({ host, target: "settings" });
  const image = within(screen.getByRole("region", { name: "Image generation allowance" }));
  expect(image.getByText("$10.00/day")).toBeDefined(); expect(image.getByText("$0.80")).toBeDefined();
  expect(image.getByText("Reservations")).toBeDefined(); expect(image.getByText("$1.60")).toBeDefined();
  expect(image.getByText("$7.60")).toBeDefined(); expect(image.getByText("America/Los_Angeles")).toBeDefined();
  expect(image.getByText("Resets at owner-local midnight. Timezone edits take effect at the next rollover.")).toBeDefined();
  expect(image.getByText("Revision outcome: Revision 3 recorded · daily amount unchanged · timezone change deferred until rollover.")).toBeDefined();
  expect(within(screen.getByRole("region", { name: "Paid-sending allowance" })).getByText("$5.00/day")).toBeDefined();
  expect(screen.getByText("Neither allowance grants ad-spend authority. Every ad-spend call requires its own exact approval.")).toBeDefined();
});
it("labels each truth model and displays gaps, restatement and unavailable CAC reasons", async () => {
  const host = await domainHost(); show({ host, target: "measure" });
  expect(within(screen.getByRole("article", { name: "Recorded costs" })).getByText("OM ledger")).toBeDefined();
  const platform = within(screen.getByRole("article", { name: "Platform acquisition report" }));
  expect(platform.getByText("Platform report")).toBeDefined(); expect(platform.getByText("Unavailable")).toBeDefined();
  expect(platform.getByText("Mixed USD/EUR report; CAC unavailable without a declared currency basis.")).toBeDefined();
  expect(platform.getByText("One account report missing.")).toBeDefined();
  const attribution = within(screen.getByRole("article", { name: "Verified signup attribution" }));
  expect(attribution.getByText("OM attribution")).toBeDefined(); expect(attribution.getByText("$24.00")).toBeDefined();
  expect(attribution.getByText("Restates report-attribution-v1")).toBeDefined();
  expect(attribution.getByText("Restated October 13 at 10:00 after late verified signups.")).toBeDefined();
  const grant = within(screen.getByRole("region", { name: "Measurement grant" }));
  expect(grant.getByText("Verified signup")).toBeDefined(); expect(grant.getByText("Reporting account")).toBeDefined();
  expect(grant.getByText("Consent is rechecked at dispatch. This grant cannot change campaigns, export arbitrary data or invoke arbitrary tools.")).toBeDefined();
});
it("shows useful reauthentication and lost plugin authority, with operation/job/audit correlation", async () => {
  const host = await domainHost(); show({ host, target: "connections" });
  expect(within(screen.getByRole("article", { name: "Creative account" })).getByText("Reauthenticate in the server browser flow, then refresh capability status.")).toBeDefined();
  cleanup(); show({ host, target: "plugins" });
  expect(within(screen.getByRole("article", { name: "Image capability" })).getByText("Updated digest invalidated prior authority; generation unavailable until review.")).toBeDefined();
  expect(within(screen.getByRole("article", { name: "Sending capability" })).getByText("Authority removed; new dispatches denied.")).toBeDefined();
  cleanup(); show({ host, target: "activity" });
  const activity = within(screen.getByRole("article", { name: "Local halt recorded" }));
  expect(activity.getByText("Operation: sample-halt-01")).toBeDefined();
  expect(activity.getByText("Job: job-halt-01")).toBeDefined(); expect(activity.getByText("Audit: audit-halt-01")).toBeDefined();
});
it("keeps shell-only snapshots compatible and shows unavailable domain details without successful defaults", async () => {
  const host = await domainHost(); const { pages: omitted, ...snapshot } = host.snapshot;
  expect(omitted).toBeDefined(); expect(parseStudioSnapshot({ input: snapshot }).ok).toBe(true);
  for (const target of ["creative", "media-library", "campaigns", "settings", "measure", "connections", "plugins", "activity"] as const) {
    show({ host, target, snapshot }); expect(screen.getByText("Domain details unavailable")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Allow$/ })).toBeNull(); cleanup();
  }
});
it("rejects a mixed-validity domain batch, nested secrets, plugin configuration and display-limit overflow", async () => {
  const host = await domainHost(); const data = pages({ snapshot: host.snapshot });
  const valid = data.creative.generations[0];
  const invalidBatches = [
    [valid, { ...valid, id: "invalid", status: "success-ish" }],
    [valid, { ...valid, id: "unsafe", costEvidence: "Bearer fixture-secret" }],
    [valid, { ...valid, id: "long", brief: "x".repeat(1025) }],
    Array.from({ length: 101 }, (_, index) => ({ ...valid, id: "generation-" + index })),
  ];
  for (const generations of invalidBatches) {
    expect(parseStudioSnapshot({ input: { ...host.snapshot, pages: { ...data, creative: { ...data.creative, generations } } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  }
  expect(parseStudioSnapshot({ input: { ...host.snapshot, pages: { ...data, operations: { ...data.operations, plugins: [{ ...data.operations.plugins[0], mcp: { command: "vendor-tool", access_token: "fixture" } }] } } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});
