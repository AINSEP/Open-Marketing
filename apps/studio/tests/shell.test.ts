/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Shell } from "../src/app/shell/Shell.js";
import { parseNavCommand } from "../src/widgets/om-chat/index.js";
import { testStudio } from "./support/studio.js";
import type { StudioApiPort } from "../src/shared/api/index.js";
import { bindSidebarEmptyClickToggle, isEmptySidebarClick } from "../src/app/shell/sidebar-blank-click.hooks.js";

beforeEach(() => {
  const stylesheet = document.createElement("style");
  stylesheet.dataset.shellFixture = "true";
  // jsdom has no bundler for imports; load the shipped shell rules without fetching assets.
  stylesheet.textContent = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
    .replace(/^@import\s+[^;]+;/gm, "");
  document.head.append(stylesheet);
});
afterEach(() => {
  cleanup();
  document.querySelector("style[data-shell-fixture]")?.remove();
});
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
    expect(root.getAttribute("data-color-scheme")).toBe("dark");
    expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "dark");
    await user.selectOptions(select, "system");
    expect(root.getAttribute("data-color-scheme")).toBe("light");
  } finally { host.dispose(); }
});

it("shows the FAB only while the assistant is closed and returns focus on Escape", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup();
    render(createElement(Shell, host.props));
    const fab = screen.getByRole("button", { name: "Assistant" });
    expect(fab.querySelector("svg")).not.toBeNull();
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    expect(getComputedStyle(fab).display).not.toBe("none");
    expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull();
    await user.click(fab);
    const panel = screen.getByRole("complementary", { name: "Assistant" });
    expect(document.activeElement).toBe(panel);
    expect(fab.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(panel).display).not.toBe("none");
    expect(getComputedStyle(fab).display).toBe("none");
    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(fab);
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Assistant" })).toBe(fab);
    expect(getComputedStyle(fab).display).not.toBe("none");
    expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull();
    expect(getComputedStyle(panel).display).toBe("none");
  } finally { host.dispose(); }
});

it("applies sidebar, dock and FAB placement rules to the rendered shell", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); const view = render(createElement(Shell, host.props));
    const shell = view.container.firstElementChild!;
    const sidebar = screen.getByRole("navigation", { name: "Features" });
    const canvas = screen.getByRole("main", { name: "Workspace canvas" }).firstElementChild!;
    const fab = screen.getByRole("button", { name: "Assistant" });
    expect(getComputedStyle(shell).display).toBe("grid");
    expect(getComputedStyle(shell).gridTemplateColumns).toContain("var(--jini-dock-width,0px)");
    expect(getComputedStyle(shell).getPropertyValue("--jini-dock-width")).toBe("");
    expect(getComputedStyle(sidebar).gridColumn).toBe("1");
    expect(getComputedStyle(sidebar).gridRow).toBe("1 / 3");
    expect(getComputedStyle(sidebar.firstElementChild!).position).toBe("sticky");
    expect(getComputedStyle(fab).position).toBe("fixed");
    expect(getComputedStyle(fab).right).toBe("20px");
    expect(getComputedStyle(fab).bottom).toBe("20px");
    // jsdom retains unresolved token values; pixel geometry needs a browser layout pass.
    expect(getComputedStyle(canvas).padding).toMatch(/\s96px$/);
    await user.click(screen.getByRole("link", { name: "Activity" }));
    const heading = screen.getByRole("heading", { name: "Activity", level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(getComputedStyle(heading).outline).toBe("none");
    await user.click(fab);
    expect(getComputedStyle(shell).getPropertyValue("--jini-dock-width")).toBe("380px");
    expect(getComputedStyle(screen.getByRole("complementary", { name: "Assistant" })).gridColumn).toBe("3");
    await user.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(getComputedStyle(shell).getPropertyValue("--jini-dock-width")).toBe("");
    expect(screen.getByRole("button", { name: "Assistant" })).toBe(fab);
  } finally { host.dispose(); }
});

it("collapses each group with the keyboard and keeps SOON previews navigable", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    const group = screen.getByRole("button", { name: "WORKSPACE" });
    group.focus(); await user.keyboard("{Enter}");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "Creative" })).toBeNull();
    await user.keyboard(" "); expect(group.getAttribute("aria-expanded")).toBe("true");
    const creative = screen.getByRole("link", { name: "Creative" });
    expect(creative.textContent).toContain("SOON"); expect(creative.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.5");
    creative.focus(); await user.keyboard("{Enter}");
    expect(host.route()).toBe("creative"); expect(creative.getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Creative", level: 1 }));
    for (const label of ["ADD-ONS", "SYSTEM"]) {
      const button = screen.getByRole("button", { name: label });
      await user.click(button); expect(button.getAttribute("aria-expanded")).toBe("false");
      await user.click(button); expect(button.getAttribute("aria-expanded")).toBe("true");
    }
  } finally { host.dispose(); }
});

it("remembers the icon rail and retains assistant draft while navigating", async () => {
  const host = testStudio(); const values = new Map<string, string>([["om.sidebar-rail.v1", "true"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const props = { ...host.props, appearance: { root: null, storage } };
  try {
    const user = userEvent.setup(); const view = render(createElement(Shell, props));
    expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(values.get("om.sidebar-rail.v1")).toBe("false");
    view.unmount(); render(createElement(Shell, props));
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeDefined();
    await screen.findByText("Sample data");
    const fab = screen.getByRole("button", { name: "Assistant" });
    await user.click(fab);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Keep this draft");
    await user.click(screen.getByRole("link", { name: "Activity" }));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByRole("complementary", { name: "Assistant" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    expect(getComputedStyle(fab).display).toBe("none");
  } finally { host.dispose(); }
});

it("keeps the rail usable when storage reads and writes fail", async () => {
  const host = testStudio();
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  try {
    const user = userEvent.setup(); render(createElement(Shell, { ...host.props, appearance: { root: null, storage } }));
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeDefined();
  } finally { host.dispose(); }
});

it("blank-space decisions exclude controls, drags, selections and non-primary clicks", () => {
  const nav = document.createElement("nav"); const span = document.createElement("span"); nav.append(span);
  const event = { target: span, button: 0, defaultPrevented: false };
  const input = { event, nav, selectingText: false, dragged: false };
  expect(isEmptySidebarClick(input)).toBe(true);
  expect(isEmptySidebarClick({ ...input, selectingText: true })).toBe(false);
  expect(isEmptySidebarClick({ ...input, dragged: true })).toBe(false);
  expect(isEmptySidebarClick({ ...input, event: { ...event, button: 1 } })).toBe(false);
  expect(isEmptySidebarClick({ ...input, event: { ...event, defaultPrevented: true } })).toBe(false);
  expect(isEmptySidebarClick({ ...input, event: { ...event, target: null } })).toBe(false);
  expect(isEmptySidebarClick({ ...input, event: { ...event, target: document.createTextNode("text") } })).toBe(false);
  expect(isEmptySidebarClick({ ...input, event: { ...event, target: document.createElement("div") } })).toBe(false);
  for (const tag of ["a", "button", "input", "select", "textarea", "summary", "label"]) {
    const control = document.createElement(tag); const child = document.createElement("span"); control.append(child); nav.append(control);
    expect(isEmptySidebarClick({ ...input, event: { ...event, target: child } })).toBe(false);
  }
  span.setAttribute("tabindex", "0"); expect(isEmptySidebarClick(input)).toBe(false);
});

it("binds guarded desktop blank clicks and removes both listeners on disposal", () => {
  const nav = document.createElement("nav"); nav.id = "blank-sidebar-fixture"; document.body.append(nav);
  const toggleRail = vi.fn(); let desktop = true;
  const stop = bindSidebarEmptyClickToggle({ doc: document, navId: nav.id, matchMedia: () => ({ matches: desktop }), toggleRail });
  const press = () => nav.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
  const click = ({ x = 10 }: { x?: number } = {}) => nav.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: 10 }));
  try {
    click(); expect(toggleRail).not.toHaveBeenCalled(); // No pointer press (e.g. keyboard/synthetic click).
    press(); click(); expect(toggleRail).toHaveBeenCalledTimes(1);
    press(); click({ x: 15 }); expect(toggleRail).toHaveBeenCalledTimes(1);
    desktop = false; press(); click(); expect(toggleRail).toHaveBeenCalledTimes(1);
    desktop = true; click(); expect(toggleRail).toHaveBeenCalledTimes(1); // Previous press cannot leak.
    stop(); press(); click(); expect(toggleRail).toHaveBeenCalledTimes(1);
  } finally { stop(); nav.remove(); }
});

it("does not collapse while selecting sidebar text and tolerates absent host capabilities", () => {
  const nav = document.createElement("nav"); nav.id = "selection-sidebar-fixture"; nav.textContent = "Workspace text"; document.body.append(nav);
  const toggleRail = vi.fn();
  const stop = bindSidebarEmptyClickToggle({ doc: document, navId: nav.id, matchMedia: () => ({ matches: true }), toggleRail });
  const range = document.createRange(); range.selectNodeContents(nav);
  try {
    document.getSelection()?.addRange(range);
    nav.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    nav.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(toggleRail).not.toHaveBeenCalled();
    bindSidebarEmptyClickToggle({ navId: nav.id, toggleRail })();
    bindSidebarEmptyClickToggle({ doc: document, navId: "missing", matchMedia: () => ({ matches: true }), toggleRail })();
    bindSidebarEmptyClickToggle({ doc: document, navId: nav.id, toggleRail })();
  } finally { document.getSelection()?.removeAllRanges(); stop(); nav.remove(); }
});
