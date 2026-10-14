/** @vitest-environment jsdom */
import { afterEach, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Shell } from "../src/app/shell/Shell.js";
import { parseNavCommand } from "../src/widgets/om-chat/index.js";
import { testStudio } from "./support/studio.js";
import type { StudioApiPort } from "../src/shared/api/index.js";

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

it.each([
  ["connected", "Connected", "Server connected"],
  ["sample", "Sample data", "Local sandbox · preview"],
  ["unavailable", "Unavailable", "Server unavailable"],
] as const)("presents %s consistently in both connection labels", async (mode, badge, sidebar) => {
  const host = testStudio();
  const original = await host.props.api.snapshot({});
  if (!original.ok) throw new Error("Expected sample fixture");
  const api = { ...host.props.api, snapshot: async () => ({ ok: true, value: { ...original.value, mode } } as const) };
  try {
    render(createElement(Shell, { ...host.props, api }));
    expect(await screen.findByText(badge)).toBeDefined();
    expect(screen.getByText(sidebar)).toBeDefined();
    expect(screen.queryByText("Connection pending")).toBeNull();
    expect(screen.queryByText("Server status unconfirmed")).toBeNull();
  } finally { host.dispose(); }
});

it.each(["", "  ", "07e8e42e-b8bb-4b0d-b01c-2733683e8258", "Ritual Studio"])("uses a friendly workspace label for %s", async workspace => {
  const host = testStudio();
  const original = await host.props.api.snapshot({});
  if (!original.ok) throw new Error("Expected sample fixture");
  const api = { ...host.props.api, snapshot: async () => ({ ok: true, value: { ...original.value, workspace } } as const) };
  try {
    render(createElement(Shell, { ...host.props, api }));
    expect(await screen.findByText(workspace === "Ritual Studio" ? workspace : "My workspace")).toBeDefined();
    if (workspace.includes("-")) expect(screen.queryByText(workspace)).toBeNull();
  } finally { host.dispose(); }
});

it("shows Connecting only while loading and Unavailable on timeout", async () => {
  const host = testStudio();
  const api = { ...host.props.api, snapshot: () => new Promise<never>(() => {}) };
  try {
    render(createElement(Shell, { ...host.props, api }));
    expect(screen.getByText("Connecting")).toBeDefined();
    expect(screen.getByText("Connecting to server")).toBeDefined();
    act(() => host.timer.advance({ ms: 10000 }));
    expect(screen.getByText("Unavailable")).toBeDefined();
    expect(screen.getByText("Server unavailable")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("timed out");
  } finally { host.dispose(); }
});

it("shows Unavailable when a snapshot fails", async () => {
  const host = testStudio();
  const api = { ...host.props.api, snapshot: async () => ({ ok: false, error: { code: "unavailable", message: "fixture", retryable: false } } as const) };
  try {
    render(createElement(Shell, { ...host.props, api }));
    expect(await screen.findByText("Unavailable")).toBeDefined();
    expect(screen.getByText("Server unavailable")).toBeDefined();
  } finally { host.dispose(); }
});

it("rejects malformed snapshot data instead of claiming a connection", async () => {
  const host = testStudio();
  // Deliberately tainted adapter output exercises the Shell's existing parse boundary.
  const api = { ...host.props.api, snapshot: async () => ({ ok: true, value: { mode: "connected", workspace: "Fixture" } }) } as unknown as StudioApiPort;
  try {
    render(createElement(Shell, { ...host.props, api }));
    expect(await screen.findByText("Unavailable")).toBeDefined();
    expect(screen.getByText("Server unavailable")).toBeDefined();
    expect(screen.queryByText("Connected")).toBeNull();
  } finally { host.dispose(); }
});

it("keeps appearance Settings usable before workspace data arrives", async () => {
  const host = testStudio();
  const root = document.createElement("div");
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const api = { ...host.props.api, snapshot: () => new Promise<never>(() => {}) };
  try {
    const user = userEvent.setup();
    render(createElement(Shell, { ...host.props, api, appearance: { root, storage } }));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const select = screen.getByRole("combobox", { name: "Appearance" });
    await user.selectOptions(select, "dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "dark");
    await user.selectOptions(select, "system");
    expect(root.style.colorScheme).toBe("light dark");
  } finally { host.dispose(); }
});

it("retains the FAB's accessible toggle and Escape focus return", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup();
    render(createElement(Shell, host.props));
    const fab = screen.getByRole("button", { name: "Assistant" });
    expect(fab.querySelector("svg")).not.toBeNull();
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    await user.click(fab);
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(document.activeElement).toBe(panel);
    expect(fab.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(fab);
    expect(fab.getAttribute("aria-expanded")).toBe("false");
  } finally { host.dispose(); }
});
