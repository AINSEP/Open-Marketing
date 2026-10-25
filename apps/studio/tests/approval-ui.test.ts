/** @vitest-environment jsdom */
import { afterEach, it, expect, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { render, screen, cleanup, within, act, renderHook } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ApprovalCard } from "../src/features/approve/index.js";
import { sampleCards } from "../src/shared/api/sample-data.js";
import { createNoopObservabilityPort } from "@jini-ai/diagnostics/observability";
import { useApprovalCard } from "../src/features/approve/ui/ApprovalCard.hooks.js";
import type { StudioApiPort } from "../src/shared/api/index.js";
import { createSampleStudioApi, instrumentStudioApi } from "../src/shared/api/index.js";
import { testRuntime } from "./support/runtime.js";

afterEach(cleanup);
it("the card shows exact JSON and only server-offered policy buttons", () => {
  const { runtime } = testRuntime(); const [under, spend, unknown] = sampleCards({ clock: runtime.clock }); const api = createSampleStudioApi({ runtime });
  render(createElement("div", {}, ...[under, spend, unknown].map(card => createElement(ApprovalCard, { key: card.cardId, card, api, runtime, sample: true }))));
  const generation = screen.getAllByRole("article", { name: "Review generation" });
  expect(within(generation[0]).getByLabelText("Exact arguments").textContent).toBe(JSON.stringify(under.arguments, null, 2));
  expect(within(generation[0]).getByRole("button", { name: "Always allow" })).toBeDefined();
  expect(within(generation[1]).queryByRole("button", { name: "Always allow" })).toBeNull();
  expect(within(screen.getByRole("article", { name: "Exact spend approval" })).queryByRole("button", { name: "Allow for this chat" })).toBeNull();
});
it("choices record honestly and expire at the injected clock deadline", async () => {
  const timer = testRuntime(); const [card] = sampleCards({ clock: timer.runtime.clock }); const api = createSampleStudioApi({ runtime: timer.runtime });
  const user = userEvent.setup(); render(createElement(ApprovalCard, { card, api, runtime: timer.runtime, sample: true }));
  await user.click(screen.getByRole("button", { name: "Allow" }));
  expect(screen.getByText("Choice recorded in preview · no external call ran")).toBeDefined();
  expect(screen.getByRole<HTMLFieldSetElement>("group", { name: "Approval choices" }).disabled).toBe(true);
  cleanup(); render(createElement(ApprovalCard, { card, api, runtime: timer.runtime, sample: true }));
  await act(async () => { timer.advance({ ms: 900000 }); });
  expect(screen.getByText("Expired · request a fresh server card")).toBeDefined();
  expect(screen.getByRole<HTMLFieldSetElement>("group", { name: "Approval choices" }).disabled).toBe(true);
});

/** Mirrors the frozen server campaign envelope; the large call remains complete in the review. */
function groupedCard(required: { runtime: ReturnType<typeof testRuntime>['runtime'] }) {
  const card = sampleCards({ clock: required.runtime.clock })[1];
  return { ...card, arguments: { tool: 'om_campaign_deploy_paused',
    campaign: { name: 'Autumn traffic', objective: 'traffic', schedule: { window: { start: 1000, end: 301000 }, timezone: 'America/Los_Angeles' }, creativeIds: ['creative-one'],
      targets: [
        { pluginId: 'google-ads', connectionId: 'google-one', accountId: 'account-us', dailyBudget: { minorUnits: 2000, currency: 'USD' }, expectedExposure: { minorUnits: 10000, currency: 'USD' } },
        { pluginId: 'linkedin-ads', connectionId: 'linkedin-one', accountId: 'account-eu', dailyBudget: { minorUnits: 3000, currency: 'EUR' }, expectedExposure: { minorUnits: 15000, currency: 'EUR' } },
      ] }, calls: [{ arguments: { text: 'x'.repeat(40000) } }, { arguments: { text: 'Keep the entire second call' } }],
  } };
}
it('shows one grouped exact card above 32 KiB without trimming any frozen arguments or adding broad choices', () => {
  const { runtime } = testRuntime(); const card = groupedCard({ runtime });
  render(createElement(ApprovalCard, { card, api: createSampleStudioApi({ runtime }), runtime, sample: false }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('region', { name: 'Grouped campaign launch' })).toBeDefined();
  expect(screen.getByText('Autumn traffic')).toBeDefined();
  expect(screen.getByText('Daily budget: $20.00 · Expected flight exposure: $100.00')).toBeDefined();
  expect(screen.getByText('Daily budget: €30.00 · Expected flight exposure: €150.00')).toBeDefined();
  expect(screen.getByLabelText('Exact arguments').textContent).toBe(JSON.stringify(card.arguments, null, 2));
  expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull();
  expect(screen.getByRole<HTMLFieldSetElement>('group', { name: 'Approval choices' }).disabled).toBe(false);
});
it('rejects oversized or secret-bearing grouped arguments intact', () => {
  const { runtime } = testRuntime(); const card = groupedCard({ runtime });
  for (const argumentsValue of [{ ...card.arguments, extra: 'x'.repeat(131072) }, { ...card.arguments, clientSecret: 'private-fixture' }]) {
    const view = render(createElement(ApprovalCard, { card: { ...card, arguments: argumentsValue }, api: createSampleStudioApi({ runtime }), runtime, sample: false }));
    expect(screen.getByText('Card cannot be displayed')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Allow$/ })).toBeNull();
    view.unmount();
  }
});

/** Real hooks and sample capture, with only the approval result controlled per fixture. */
function approvalTelemetry(required: { approve?: StudioApiPort['approve'] } = {}) {
  const timer = testRuntime(); const raw = createSampleStudioApi({ runtime: timer.runtime });
  const observed = instrumentStudioApi({ api: { ...raw, approve: required.approve ?? raw.approve }, runtime: timer.runtime, observability: createNoopObservabilityPort({}) });
  return { timer, raw, ...observed, card: sampleCards({ clock: timer.runtime.clock })[0],
    async items() { const result = await raw.recentEvents!({}); if (!result.ok) throw new Error('Missing events'); return result.value.items; } };
}
it('shown suppresses Strict Mode replay; a true remount records a new exposure and rejected cards copy no identifiers', async () => {
  const fixture = approvalTelemetry(); const props = { card: fixture.card, api: fixture.api, runtime: fixture.runtime, sample: true };
  const view = render(createElement(StrictMode, {}, createElement(ApprovalCard, props)));
  view.rerender(createElement(StrictMode, {}, createElement(ApprovalCard, { ...props, card: { ...fixture.card } })));
  expect((await fixture.items()).map(event => event.name)).toEqual(['approval.shown']); view.unmount();
  render(createElement(ApprovalCard, props)); expect((await fixture.items()).map(event => event.name)).toEqual(['approval.shown', 'approval.shown']); cleanup();
  render(createElement(ApprovalCard, { ...props, card: { ...fixture.card, cardId: 'rejected-private-id', allowedChoices: [] } }));
  expect((await fixture.items()).at(-1)).toEqual({ kind: 'error', name: 'approval.invalid_card', at: 1000, errorCode: 'invalid_card' });
});
it('one accepted choice records duration; duplicate clicks and a late failure after timeout emit only once', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<StudioApiPort['approve']>>>(); const approve = vi.fn(() => pending.promise);
  const fixture = approvalTelemetry({ approve });
  const hook = renderHook(() => useApprovalCard({ card: fixture.card, api: fixture.api, runtime: fixture.runtime, sample: true }));
  fixture.timer.advance({ ms: 321 }); let first: Promise<void>;
  act(() => { first = hook.result.current.buttons[0].onClick(); });
  await act(async () => { await hook.result.current.buttons[0].onClick(); fixture.timer.advance({ ms: 15000 }); });
  expect(approve).toHaveBeenCalledTimes(1); expect(hook.result.current.statusText).toContain('could not be confirmed');
  await act(async () => { pending.resolve({ ok: false, error: { code: 'unavailable', message: 'late-private-failure', retryable: false } }); await first!; });
  expect(hook.result.current.statusText).toContain('could not be confirmed');
  const events = await fixture.items(); expect(events.map(event => event.name)).toEqual(['approval.shown', 'approval.clicked', 'approval.submit_failed']);
  expect(events[1]).toMatchObject({ choice: 'allow', durationMs: 321 }); expect(events[2]).toMatchObject({ errorCode: 'timeout' });
  await act(async () => { fixture.timer.advance({ ms: 900000 }); });
  expect((await fixture.items()).filter(event => event.name === 'approval.expired')).toEqual([]); hook.unmount(); expect(fixture.timer.pending()).toBe(0);
});
it('unanswered expiry emits once while a decision at the deadline sends no approval', async () => {
  const approve = vi.fn(async () => ({ ok: true, value: { status: 'recorded' } } as const)); const fixture = approvalTelemetry({ approve });
  const hook = renderHook(() => useApprovalCard({ card: fixture.card, api: fixture.api, runtime: fixture.runtime, sample: true }));
  const elapsed = fixture.card.expiresAt - 1000;
  await act(async () => { fixture.timer.advance({ ms: elapsed }); await hook.result.current.buttons[0].onClick(); });
  hook.rerender(); expect(approve).not.toHaveBeenCalled();
  expect((await fixture.items()).filter(event => event.name === 'approval.expired')).toEqual([{ kind: 'product', name: 'approval.expired', at: fixture.card.expiresAt,
    cardId: fixture.card.cardId, operationId: fixture.card.operationId, durationMs: elapsed }]);
});

it('each server-offered choice records the selected value without a separate decided event', async () => {
  for (const choice of ['allow', 'allow_chat', 'always_allow', 'cancel'] as const) {
    const fixture = approvalTelemetry(); const hook = renderHook(() => useApprovalCard({ card: fixture.card, api: fixture.api, runtime: fixture.runtime, sample: true }));
    await act(async () => { await hook.result.current.buttons.find(button => button.choice === choice)!.onClick(); });
    expect((await fixture.items()).map(event => event.name)).toEqual(['approval.shown', 'approval.clicked']);
    expect((await fixture.items())[1]).toMatchObject({ choice, durationMs: 0 }); hook.unmount();
  }
});
