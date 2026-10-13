/** @vitest-environment jsdom */
import { afterEach, it, expect } from "vitest";
import { createElement } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Shell } from "../src/app/Shell.js";
import { parseNavCommand } from "../src/widgets/om-chat/index.js";
import { testStudio } from "./support/studio.js";

afterEach(cleanup);
it("left navigation changes the center canvas and labels every route as sample data", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByText("Preview workspace. All content and approvals are samples; no external call or spend will run.");
    expect(screen.getByRole("navigation", { name: "Features" })).toBeDefined();
    expect(screen.getByRole("main", { name: "Workspace canvas" })).toBeDefined();
    for (const label of ["Creative", "Media", "Campaigns", "Measure", "Connections", "Plugins", "Activity", "Settings"]) expect(screen.getByRole("link", { name: label })).toBeDefined();
    await user.click(screen.getByRole("link", { name: "Campaigns" }));
    const heading = screen.getByRole("heading", { name: "Campaigns", level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("link", { name: "Campaigns" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("The ritual starts here")).toBeDefined();
    expect(host.route()).toBe("campaigns");
  } finally { host.dispose(); }
});
it("preserved command recognition never accepts an unsupported route", () => {
  expect(parseNavCommand({ command: "app-control navigate --target campaigns" })).toBe("campaigns");
  expect(parseNavCommand({ command: "navigate design-systems" })).toBeNull();
});
