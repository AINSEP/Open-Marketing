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
  await user.click(screen.getByRole("button", { name: "Allow", exact: true }));
  expect(screen.getByText("Choice recorded in preview · no external call ran")).toBeDefined();
  expect(screen.getByRole<HTMLFieldSetElement>("group").disabled).toBe(true);
  cleanup(); render(createElement(ApprovalCard, { card, api, runtime: timer.runtime, sample: true }));
  await act(async () => { timer.advance({ ms: 900000 }); });
  expect(screen.getByText("Expired · request a fresh server card")).toBeDefined();
  expect(screen.getByRole<HTMLFieldSetElement>("group").disabled).toBe(true);
});
