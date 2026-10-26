/** @vitest-environment jsdom */
import { act, renderHook, cleanup } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance, useAppearance } from "../src/shared/ui/index.js";
import { browserStorage } from "../src/composition/adapters/browser.js";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { THEMES, ACCENTS } from "../src/themes/registry.js";

afterEach(cleanup);

function mediaFixture() {
  const listeners = new Set<() => void>();
  const media = { matches: true,
    addEventListener: vi.fn((_type: "change", listener: () => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: "change", listener: () => void) => { listeners.delete(listener); }),
  };
  const matchMedia = vi.fn(() => media);
  return { media, matchMedia, listeners, change({ matches }: { matches: boolean }) { media.matches = matches; for (const listener of listeners) listener(); } };
}
function change({ value }: { value: string }): ChangeEvent<HTMLSelectElement> { return { currentTarget: { value } } as ChangeEvent<HTMLSelectElement>; }

it.each([
  [null, "light", "light"], ["unknown", "light", "light"], ["system", "system", "dark"],
  ["light", "light", "light"], ["dark", "dark", "dark"],
] as const)("restores scheme %s and the shipped theme before mounting", (saved, preference, scheme) => {
  const root = document.createElement("div"); const media = mediaFixture();
  const storage = { getItem: vi.fn((key: string) => key === "om.appearance.v1" ? saved : "unshipped-theme"), setItem: vi.fn() };
  expect(applyAppearance({ root, storage, matchMedia: media.matchMedia })).toEqual({ theme: "modernist", scheme: preference, accent: "default" });
  expect(root.getAttribute("data-color-scheme")).toBe(scheme);
  expect(root.getAttribute("data-admin-theme")).toBe("modernist");
  expect(root.style.colorScheme).toBe("");
  expect(storage.setItem).not.toHaveBeenCalled(); expect(media.listeners.size).toBe(0);
});

it("uses Modernist/Light when storage is missing or blocked, including an inert host", () => {
  const root = document.createElement("div");
  const storage = { getItem() { throw new Error("blocked"); }, setItem: vi.fn() };
  expect(applyAppearance({ root, storage })).toEqual({ theme: "modernist", scheme: "light", accent: "default" });
  expect(root.getAttribute("data-color-scheme")).toBe("light");
  expect(applyAppearance({ root: null, storage: null })).toEqual({ theme: "modernist", scheme: "light", accent: "default" });
});

it("contains a browser's throwing localStorage getter at the host boundary", () => {
  const host = Object.create(null) as Window;
  Object.defineProperty(host, "localStorage", { get() { throw new Error("blocked"); } });
  expect(browserStorage({ host })).toBeNull();
});

it("subscribes only for System, responds to OS changes, and cleans up on choice and unmount", () => {
  const root = document.createElement("div"); const media = mediaFixture();
  const storage = { getItem: () => "system", setItem: vi.fn() };
  const view = renderHook(() => useAppearance({ root, storage, matchMedia: media.matchMedia }));
  expect(root.getAttribute("data-color-scheme")).toBe("dark"); expect(media.listeners.size).toBe(1);
  act(() => media.change({ matches: false })); expect(root.getAttribute("data-color-scheme")).toBe("light");
  act(() => view.result.current.change(change({ value: "dark" })));
  expect(view.result.current.preference).toBe("dark"); expect(media.listeners.size).toBe(0);
  expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "dark");
  act(() => media.change({ matches: false })); expect(root.getAttribute("data-color-scheme")).toBe("dark");
  act(() => view.result.current.change(change({ value: "system" }))); expect(media.listeners.size).toBe(1);
  expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "system");
  view.unmount(); expect(media.listeners.size).toBe(0);
});

it("keeps in-memory choices on failed writes and normalizes invalid scheme/theme input", () => {
  const root = document.createElement("div");
  const storage = { getItem: () => null, setItem() { throw new Error("quota"); } };
  const { result } = renderHook(() => useAppearance({ root, storage }));
  act(() => result.current.change(change({ value: "dark" })));
  expect(result.current.preference).toBe("dark"); expect(root.getAttribute("data-color-scheme")).toBe("dark");
  act(() => result.current.change(change({ value: "invalid" })));
  expect(result.current.preference).toBe("light"); expect(root.getAttribute("data-color-scheme")).toBe("light");
  act(() => result.current.changeTheme(change({ value: "quiet" })));
  expect(result.current.theme).toBe("modernist"); expect(root.getAttribute("data-admin-theme")).toBe("modernist");
});

it("persists the admitted theme and resolves System without media to deterministic Light", () => {
  const root = document.createElement("div"); const storage = { getItem: () => "system", setItem: vi.fn() };
  const { result } = renderHook(() => useAppearance({ root, storage }));
  act(() => result.current.changeTheme(change({ value: "modernist" })));
  expect(storage.setItem).toHaveBeenLastCalledWith("om.admin-theme.v1", "modernist");
  expect(root.getAttribute("data-color-scheme")).toBe("light");
});

it.each(["{", "null", "true", "[]", "{}", '{"glass":"toString","quiet":"blue"}', " ".repeat(1025)])("defaults malformed or oversized accent records: %s", saved => {
  const root = document.createElement("div"); root.setAttribute("data-accent", "blue");
  const storage = { getItem: (key: string) => key === "om.admin-theme.v1" ? "glass" : saved, setItem: vi.fn() };
  expect(applyAppearance({ root, storage })).toEqual({ theme: "glass", scheme: "light", accent: "default" });
  expect(root.hasAttribute("data-accent")).toBe(false); expect(storage.setItem).not.toHaveBeenCalled();
});
it("restores per-theme accents before mount, keeps them through System flips, and survives blocked writes", () => {
  const root = document.createElement("div"); const media = mediaFixture();
  const values: Record<string, string> = { "om.admin-theme.v1": "glass", "om.appearance.v1": "system", "om.admin-accents.v1": '{"glass":"blue","mono":"violet","quiet":"green"}' };
  const storage = { getItem: (key: string) => values[key] ?? null, setItem() { throw new Error("blocked"); } };
  expect(applyAppearance({ root, storage, matchMedia: media.matchMedia })).toEqual({ theme: "glass", scheme: "system", accent: "blue" });
  expect(root.getAttribute("data-accent")).toBe("blue");
  const view = renderHook(() => useAppearance({ root, storage, matchMedia: media.matchMedia }));
  act(() => media.change({ matches: false })); expect(view.result.current.scheme).toBe("light");
  expect(root.getAttribute("data-accent")).toBe("blue"); expect(root.style.length).toBe(0);
  act(() => view.result.current.changeTheme(change({ value: "mono" })));
  expect(root.getAttribute("data-accent")).toBe("violet"); expect(media.listeners.size).toBe(1);
  act(() => view.result.current.changeAccent({ currentTarget: { value: "default" } } as ChangeEvent<HTMLInputElement>));
  expect(root.hasAttribute("data-accent")).toBe(false);
  act(() => view.result.current.changeTheme(change({ value: "glass" }))); expect(root.getAttribute("data-accent")).toBe("blue");
  act(() => view.result.current.changeAccent({ currentTarget: { value: "unknown" } } as ChangeEvent<HTMLInputElement>));
  expect(view.result.current.accent).toBe("default"); expect(root.hasAttribute("data-accent")).toBe(false);
  view.unmount(); expect(media.listeners.size).toBe(0);
});
it("persists only known per-theme choices and restores them on remount", () => {
  const values = new Map<string, string>([["om.admin-accents.v1", '{"unknown":"blue","mono":"invalid"}']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const host = { root: document.createElement("div"), storage };
  const view = renderHook(() => useAppearance(host));
  act(() => view.result.current.changeAccent({ currentTarget: { value: "green" } } as ChangeEvent<HTMLInputElement>));
  act(() => view.result.current.changeTheme(change({ value: "neumorphic" })));
  expect(view.result.current.accent).toBe("default");
  act(() => view.result.current.changeAccent({ currentTarget: { value: "violet" } } as ChangeEvent<HTMLInputElement>));
  expect(JSON.parse(values.get("om.admin-accents.v1")!)).toEqual({ modernist: "green", glass: "default", neumorphic: "violet", "modern-premium": "default", mono: "default" });
  view.unmount(); const restored = renderHook(() => useAppearance(host));
  expect(restored.result.current).toMatchObject({ theme: "neumorphic", accent: "violet" });
  act(() => restored.result.current.changeTheme(change({ value: "modernist" }))); expect(restored.result.current.accent).toBe("green");
});
it("keeps registry preview samples and accent dots equal to the shipped CSS", () => {
  for (const theme of THEMES) for (const scheme of ["light", "dark"] as const) {
    const css = readFileSync(new FileURL(`../src/themes/${theme.id}.css`, import.meta.url), "utf8");
    const block = css.split(`:root[data-admin-theme="${theme.id}"][data-color-scheme="${scheme}"] {`)[1]!.split("}")[0]!;
    const tokens = Object.fromEntries([...block.matchAll(/(--jini-[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]!.trim()]));
    const bg = tokens[`--jini-theme-${scheme}-bg`]!;
    expect(theme.preview[scheme]).toEqual({ bg: tokens["--jini-app-bg"]!.replace("var(--jini-bg)", bg), panel: tokens["--jini-panel-bg"]!.replace("var(--jini-bg)", bg), text: tokens[`--jini-theme-${scheme}-text`], accent: tokens[`--jini-theme-${scheme}-primary`] });
  }
  const css = readFileSync(new FileURL("../src/themes/accents.css", import.meta.url), "utf8");
  for (const accent of [ACCENTS.green, ACCENTS.blue, ACCENTS.violet]) for (const scheme of ["light", "dark"] as const) {
    const block = css.split(`:root[data-accent="${accent.id}"][data-color-scheme="${scheme}"] {`)[1]!.split("}")[0]!;
    expect(block).toContain(`--jini-primary: ${accent.swatch[scheme]};`);
  }
});

/** Read authored CSS through Node; bypass Vite's browser asset URL rewriting. */
function cssTokens(required: { file: string; selector: string }): Record<string, string> {
  const css = readFileSync(new FileURL(`../src/themes/${required.file}.css`, import.meta.url), "utf8");
  const block = css.split(required.selector + " {")[1]!.split("}")[0]!;
  return Object.fromEntries([...block.matchAll(/(--jini-[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]!.trim()]));
}

/** WCAG relative luminance for the shipped opaque six-digit sRGB tokens; constant work. */
function luminance(required: { hex: string }): number {
  expect(required.hex).toMatch(/^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map(offset => Number.parseInt(required.hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(required: { foreground: string; background: string }): number {
  const foreground = luminance({ hex: required.foreground }); const background = luminance({ hex: required.background });
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

it.each(["light", "dark"] as const)("Modern keeps every %s accent AA on buttons, hovered buttons and links", scheme => {
  const theme = cssTokens({ file: "modernist", selector: `:root[data-admin-theme="modernist"][data-color-scheme="${scheme}"]` });
  // Assert the wiring as well as the pairs: the old green hover fails with Blue/Violet white ink.
  expect(theme["--jini-accent"]).toBe("var(--jini-primary)");
  expect(theme["--jini-accent-hover"]).toBe("var(--jini-primary)");
  expect(theme["--jini-accent-ink"]).toBe("var(--jini-primary-ink)");
  expect(theme["--jini-link"]).toBe("var(--jini-accent-strong)");
  for (const accent of Object.values(ACCENTS)) {
    const tokens = accent.id === "default" ? {} : cssTokens({ file: "accents", selector: `:root[data-accent="${accent.id}"][data-color-scheme="${scheme}"]` });
    const primary = tokens["--jini-primary"] ?? theme[`--jini-theme-${scheme}-primary`]!;
    const ink = tokens["--jini-primary-ink"] ?? theme[`--jini-theme-${scheme}-primary-ink`]!;
    expect(contrast({ foreground: ink, background: primary }), `${accent.id} button and hover`).toBeGreaterThanOrEqual(4.5);
    const link = tokens["--jini-accent-strong"] ?? theme["--jini-accent-strong"]!;
    const bg = theme[`--jini-theme-${scheme}-bg`]!;
    for (const background of [bg, theme[`--jini-theme-${scheme}-surface`]!, theme["--jini-panel-bg"]!.replace("var(--jini-bg)", bg)]) {
      expect(contrast({ foreground: link, background }), `${accent.id} link on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
