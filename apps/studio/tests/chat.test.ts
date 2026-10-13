/** @vitest-environment jsdom */
import { afterEach, it, expect } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Shell } from "../src/app/Shell.js";
import { testStudio } from "./support/studio.js";

afterEach(cleanup);
it("keyboard opens the global panel, Escape closes it, and focus returns to the FAB", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByText("A little clarity.", { exact: false });
    const fab = screen.getByRole("button", { name: "Assistant" });
    fab.focus(); await user.keyboard("{Enter}");
    expect(fab.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Assistant" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(fab);
  } finally { host.dispose(); }
});
it("a sample chat requests native navigation and acknowledges only the rendered canvas", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByText("A little clarity.", { exact: false });
    await user.click(screen.getByRole("button", { name: "Assistant" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "open campaigns");
    await user.click(screen.getByRole("button", { name: "Send" }));
    for (let index = 0; index < 4; index += 1) await act(async () => { host.timer.advance({ ms: 450 }); });
    expect(screen.getByRole("heading", { name: "Campaigns", level: 1 })).toBeDefined();
    expect(screen.getByText("Opened campaigns in this browser.")).toBeDefined();
    expect(host.props.session.getSnapshot().navigation).toEqual({ status: "completed", actionId: expect.any(String), target: "campaigns" });
  } finally { host.dispose(); }
});
