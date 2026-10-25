/** @vitest-environment jsdom */
import { afterEach, it, expect } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, within, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ApprovalCard } from "../src/features/approve/index.js";
import { sampleCards } from "../src/shared/api/sample-data.js";
import { createSampleStudioApi } from "../src/shared/api/index.js";
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
