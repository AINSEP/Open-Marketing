/** @vitest-environment jsdom */
import { act, renderHook, cleanup } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance, useAppearance } from "../src/shared/ui/index.js";
import { browserStorage } from "../src/composition/adapters/browser.js";

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
  expect(applyAppearance({ root, storage, matchMedia: media.matchMedia })).toEqual({ theme: "modernist", scheme: preference });
  expect(root.getAttribute("data-color-scheme")).toBe(scheme);
  expect(root.getAttribute("data-admin-theme")).toBe("modernist");
  expect(root.style.colorScheme).toBe("");
  expect(storage.setItem).not.toHaveBeenCalled(); expect(media.listeners.size).toBe(0);
});

it("uses Modernist/Light when storage is missing or blocked, including an inert host", () => {
  const root = document.createElement("div");
  const storage = { getItem() { throw new Error("blocked"); }, setItem: vi.fn() };
  expect(applyAppearance({ root, storage })).toEqual({ theme: "modernist", scheme: "light" });
  expect(root.getAttribute("data-color-scheme")).toBe("light");
  expect(applyAppearance({ root: null, storage: null })).toEqual({ theme: "modernist", scheme: "light" });
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
