/** @vitest-environment jsdom */
import { afterEach, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { WorkspaceCanvas } from "../src/widgets/workspace-canvas/index.js";
import { createSampleStudioApi, parseStudioSnapshot } from "../src/shared/api/index.js";
import { parseLaunchOutcomes } from "../src/widgets/workspace-canvas/ui/WorkspaceCanvas.hooks.js";
import type { StudioApiPort, StudioSnapshot } from "../src/shared/api/index.js";
import type { NavigationTarget, RunEvent } from "@open-marketing/contracts";
import { testRuntime } from "./support/runtime.js";
import { testStudio } from "./support/studio.js";
import { Shell } from "../src/app/shell/Shell.js";
import { createChatSession } from "../src/features/chat-run/index.js";

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
it("keeps shell-only snapshots compatible without inventing successful domain defaults", async () => {
  const host = await domainHost(); const { pages: omitted, ...snapshot } = host.snapshot;
  expect(omitted).toBeDefined(); expect(parseStudioSnapshot({ input: snapshot }).ok).toBe(true);
  for (const target of ["creative", "settings", "measure", "connections", "plugins"] as const) {
    show({ host, target, snapshot }); expect(screen.getByText("Domain details unavailable")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Allow$/ })).toBeNull(); cleanup();
  }
});

const emptyCanvasCases = [
  { target: "campaigns", message: "Your campaigns and draft reviews will appear here.", link: "Connect an ad account in Integrations", button: "Ask the assistant to draft one" },
  { target: "media-library", message: "Your images, videos, and creative assets will appear here.", link: "Connect an account in Integrations", button: "Ask the assistant to create an image" },
  { target: "activity", message: "Your jobs, approvals, and outcomes will appear here.", link: "Connect an account in Integrations", button: "Ask the assistant to help you get started" },
] as const;

it.each(emptyCanvasCases)("guides first use on $target when optional page data is absent", async ({ target, message, link, button }) => {
  const host = await domainHost(); const { pages: omitted, ...snapshot } = host.snapshot;
  expect(omitted).toBeDefined();
  const onOpenChat = vi.fn();
  show({ host: { ...host, onOpenChat }, target, snapshot });
  expect(screen.getByRole("status").textContent).toBe(message);
  expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("#/addons/integrations");
  expect(screen.queryByText("Domain details unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Allow$/ })).toBeNull();
  expect(onOpenChat).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: button }));
  expect(onOpenChat).toHaveBeenCalledOnce();
});

it.each(emptyCanvasCases)("guides first use on $target when the API supplies empty lists", async ({ target, message, link, button }) => {
  const host = await domainHost(); const data = pages({ snapshot: host.snapshot });
  const snapshot: StudioSnapshot = { ...host.snapshot, mode: "connected", pages: {
    ...data,
    creative: { ...data.creative, assets: [] },
    campaigns: { ...data.campaigns, drafts: [], halts: [] },
    operations: { ...data.operations, activity: [] },
  } };
  const onOpenChat = vi.fn();
  show({ host: { ...host, onOpenChat }, target, snapshot });
  expect(screen.getByRole("status").textContent).toBe(message);
  expect(screen.getByRole("link", { name: link }).getAttribute("href")).toBe("#/addons/integrations");
  expect(screen.queryByRole("button", { name: /^Allow$/ })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: button }));
  expect(onOpenChat).toHaveBeenCalledOnce();
});

it("keeps campaign halt evidence visible even without campaign drafts", async () => {
  const host = await domainHost(); const data = pages({ snapshot: host.snapshot });
  const snapshot: StudioSnapshot = { ...host.snapshot, pages: { ...data, campaigns: { ...data.campaigns, drafts: [] } } };
  show({ host, target: "campaigns", snapshot });
  expect(screen.queryByRole("article", { name: "Get started" })).toBeNull();
  expect(within(screen.getByRole("article", { name: "Launch account" })).getByText("blocked")).toBeDefined();
});

it.each(["campaigns", "media-library", "activity"] as const)("preserves populated %s content", async target => {
  const host = await domainHost(); show({ host, target });
  expect(screen.queryByRole("article", { name: "Get started" })).toBeNull();
  expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
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

/** Same evidence shape returned by the server's read-only deployment reconciliation tool. */
function launchEvidence() {
  return { complete: false, entities: [{ operationId: 'google-child', entityId: 'google-ref', state: 'paused' }], outcomes: [
    { operationId: 'google-child', tool: 'vendor_google_ads_campaign_deploy_paused', connectionId: 'google-one', accountId: 'us', result: { status: 'acknowledged', entityIds: ['google-ref'], references: { campaign: 'google-ref' } } },
    { operationId: 'linkedin-child', tool: 'vendor_linkedin_ads_campaign_deploy_paused', connectionId: 'linkedin-one', accountId: 'eu', result: { status: 'unknown', entityIds: ['partial-ref'], references: { campaign: 'partial-ref' } } },
  ] };
}
it('preserves paused, draft, partial failure and unknown references without interpreting them as live delivery', () => {
  const evidence = launchEvidence();
  expect(parseLaunchOutcomes({ input: evidence })).toMatchObject({ status: 'Partial deployment · reconcile unresolved destinations', rows: [
    { vendor: 'google ads', status: 'Created · paused' }, { vendor: 'linkedin ads', status: 'Unknown · reconciling', references: expect.stringContaining('partial-ref') },
  ] });
  const draft = { ...evidence, complete: true, entities: [{ operationId: 'google-child', entityId: 'google-ref', state: 'draft' }], outcomes: [evidence.outcomes[0]] };
  expect(parseLaunchOutcomes({ input: { status: 'submitted', hierarchy: draft, outcomes: draft.outcomes } })?.rows[0]?.status).toBe('Created · draft');
  const failed = { ...evidence, outcomes: [evidence.outcomes[0], { ...evidence.outcomes[1], result: { status: 'failed', entityIds: ['partial-ref'] } }] };
  expect(parseLaunchOutcomes({ input: failed })?.rows[1]).toMatchObject({ status: 'Failed · partial references preserved', references: expect.stringContaining('partial-ref') });
});
it('rejects a malformed/duplicate/secret-bearing launch batch and never fills in missing paused evidence', () => {
  const evidence = launchEvidence();
  expect(parseLaunchOutcomes({ input: { ...evidence, outcomes: [...evidence.outcomes, { ...evidence.outcomes[1], result: { status: 'success-ish' } }] } })).toBeNull();
  expect(parseLaunchOutcomes({ input: { ...evidence, outcomes: [evidence.outcomes[0], evidence.outcomes[0]] } })).toBeNull();
  expect(parseLaunchOutcomes({ input: { ...evidence, token: { access_token: 'private-fixture' } } })).toBeNull();
  expect(parseLaunchOutcomes({ input: { ...evidence, entities: [] } })?.rows[0]?.status).toBe('Created · serving state unconfirmed');
});
it('reconciles through only the read tool and retains partial references on a later failed read', async () => {
  const host = await domainHost(); const data = pages({ snapshot: host.snapshot });
  const original = host.snapshot.cards[1];
  const card = { ...original, operationId: 'deployment-one', arguments: { tool: 'om_campaign_deploy_paused' } };
  const snapshot = { ...host.snapshot, cards: [card], pages: { ...data, campaigns: { ...data.campaigns, drafts: [{ ...data.campaigns.drafts[0], approvalCardId: card.cardId }] } } };
  const calls: unknown[] = []; let reads = 0;
  const api = { ...host.api,
    tool: async (input: { call: import('@open-marketing/contracts').ToolCall }) => { calls.push(input.call); return { ok: true as const, value: { status: 'completed' as const, output: launchEvidence() } }; },
    operation: async () => { reads++; return { ok: false as const, error: { code: 'unavailable' as const, message: 'Fixture read failed', retryable: false } }; },
  };
  const view = render(createElement(WorkspaceCanvas, { ...host, api, snapshot, target: 'campaigns' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile deployment (read only)' }));
  await waitFor(() => expect(screen.getByText('Unknown · reconciling')).toBeDefined());
  expect(calls).toEqual([{ name: 'om_campaign_reconcile_deployment', operationId: expect.any(String), input: { operationId: 'deployment-one' } }]);
  expect(JSON.stringify(calls)).not.toContain('create_paused');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh launch outcome' }));
  await waitFor(() => expect(reads).toBe(1));
  expect(screen.getByText(/"campaign":"partial-ref"/)).toBeDefined();
  view.unmount();
});
it('shows supplied overview metrics without zero-padding and removes decorative artwork/footer copy', async () => {
  const host = await domainHost(); const view = show({ host, target: 'workspaces' });
  expect(view.container.querySelectorAll('.metric-card')).toHaveLength(host.snapshot.metrics.length);
  expect(view.container.querySelector('.metric-card strong')?.textContent).toBe('3');
  expect(view.container.querySelector('.brief-banner,.canvas-card-art,.canvas-footer')).toBeNull();
});
it('shows the grouped launch review from a live shell-only snapshot without hiding account halt evidence', async () => {
  const host = await domainHost(); const { pages: data, ...shellSnapshot } = host.snapshot;
  const card = { ...host.snapshot.cards[1], arguments: { tool: 'om_campaign_deploy_paused' } };
  const snapshot = { ...shellSnapshot, cards: [card] };
  show({ host, target: 'campaigns', snapshot });
  expect(screen.getByRole('region', { name: 'Campaign launch review' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Reconcile deployment (read only)' })).toBeDefined();
  expect(screen.queryByText('Your campaigns and draft reviews will appear here.')).toBeNull();
  cleanup();
  if (!data) throw new Error('Fixture pages required');
  show({ host, target: 'campaigns', snapshot: { ...snapshot, pages: { ...data, campaigns: { ...data.campaigns, drafts: [] } } } });
  expect(screen.getByRole('region', { name: 'Account halt status' })).toBeDefined();
  expect(screen.getByRole('region', { name: 'Campaign launch review' })).toBeDefined();
});

/** Real session events arrive after the shell's one startup read; no snapshot-injected card. */
it.each(['standalone', 'draft'] as const)('delivers a live %s launch card and retains its outcome after resolution', async placement => {
  const host = testStudio(); const source = await host.props.api.snapshot({});
  if (!source.ok || !source.value.pages) throw new Error('Fixture pages required');
  const card = { ...source.value.cards[1], cardId: 'live-launch', operationId: 'live-deployment', arguments: { tool: 'om_campaign_deploy_paused' } };
  const { pages: data, ...shellOnly } = source.value;
  const snapshot: StudioSnapshot = { ...shellOnly, mode: 'connected', cards: [], ...(placement === 'draft' ? { pages: {
    ...data, campaigns: { ...data.campaigns, drafts: [{ ...data.campaigns.drafts[0], approvalCardId: card.cardId }] },
  } } : {}) };
  const resolveCard = Promise.withResolvers<void>();
  const reads: string[] = []; const approvals: unknown[] = []; let snapshotReads = 0;
  const event = (input: { sequence: number; kind: RunEvent['kind']; payload: RunEvent['payload'] }): RunEvent => ({
    protocolVersion: 1, eventId: 'live-event-' + input.sequence, runId: 'live-run', correlationId: 'live-correlation', traceId: 'live-trace', ...input,
  });
  const api: StudioApiPort = { ...host.props.api,
    async snapshot() { snapshotReads++; return { ok: true, value: snapshot }; },
    async start() { return { ok: true, value: { runId: 'live-run', status: 'pending', expiresAt: 301000 } }; },
    async *events() {
      const confirmation = event({ sequence: 1, kind: 'tool_requested', payload: { type: 'confirmation', card } });
      yield { ok: true, value: confirmation }; yield { ok: true, value: confirmation };
      await resolveCard.promise;
      yield { ok: true, value: event({ sequence: 2, kind: 'tool_result', payload: { type: 'confirmation_resolved', cardId: card.cardId, operationId: card.operationId, status: 'completed' } }) };
      yield { ok: true, value: event({ sequence: 3, kind: 'ended', payload: {} }) };
    },
    async approve(input) { approvals.push(input.response); return { ok: true, value: { status: 'recorded' } }; },
    async operation(input) { reads.push(input.operationId); return { ok: true, value: { status: 'completed', operationId: input.operationId, output: launchEvidence() } }; },
  };
  const session = createChatSession({ api, runtime: host.props.runtime, navigate: input => host.props.navigation.apply({ input: input.action }) });
  const view = render(createElement(Shell, { ...host.props, api, session }));
  let sending: Promise<void> | undefined;
  try {
    const canvas = within(screen.getByRole('main', { name: 'Workspace canvas' }));
    await waitFor(() => expect(snapshotReads).toBe(1));
    await act(async () => { host.props.navigation.select({ target: 'campaigns' }); });
    expect(canvas.queryByRole('button', { name: /^Allow$/ })).toBeNull();
    act(() => { sending = session.send({ text: 'Prepare a fixture campaign' }); });
    await waitFor(() => expect(canvas.getAllByRole('button', { name: /^Allow$/ })).toHaveLength(1));
    fireEvent.click(canvas.getByRole('button', { name: /^Allow$/ }));
    await waitFor(() => expect(canvas.getByText('Choice recorded · awaiting the server action result')).toBeDefined());
    expect(approvals).toEqual([{ cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' }]);
    await act(async () => { resolveCard.resolve(); await sending; });
    expect(session.getSnapshot().cards).toEqual([]);
    expect(canvas.queryByRole('button', { name: /^Allow$/ })).toBeNull();
    fireEvent.click(canvas.getByRole('button', { name: 'Refresh launch outcome' }));
    await waitFor(() => expect(canvas.getByText('Unknown · reconciling')).toBeDefined());
    expect(reads).toEqual(['live-deployment']); expect(snapshotReads).toBe(1);
    expect(canvas.getByText(/"campaign":"partial-ref"/)).toBeDefined();
  } finally {
    resolveCard.resolve(); await sending; view.unmount(); session.dispose(); host.dispose();
  }
});
