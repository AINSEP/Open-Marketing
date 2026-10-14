/** @vitest-environment jsdom */
import { act, renderHook, cleanup } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance, useAppearance } from "../src/shared/ui/index.js";
import { browserStorage } from "../src/composition/adapters/browser.js";

afterEach(cleanup);

it.each([
  [null, "system", "light dark"],
  ["unknown", "system", "light dark"],
  ["system", "system", "light dark"],
  ["light", "light", "light"],
  ["dark", "dark", "dark"],
] as const)("applies the allowlisted saved preference %s before mounting", (saved, preference, scheme) => {
  const root = document.createElement("div");
  const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() };
  expect(applyAppearance({ root, storage })).toBe(preference);
  expect(root.style.colorScheme).toBe(scheme);
  expect(storage.getItem).toHaveBeenCalledExactlyOnceWith("om.appearance.v1");
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("uses System when storage is missing or throws", () => {
  const root = document.createElement("div");
  root.style.colorScheme = "dark";
  expect(applyAppearance({ root, storage: null })).toBe("system");
  const storage = { getItem() { throw new Error("blocked"); }, setItem: vi.fn() };
  expect(applyAppearance({ root, storage })).toBe("system");
  expect(root.style.colorScheme).toBe("light dark");
});

it("contains a browser's throwing localStorage getter at the host boundary", () => {
  const host = Object.create(null) as Window;
  Object.defineProperty(host, "localStorage", { get() { throw new Error("blocked"); } });
  expect(browserStorage({ host })).toBeNull();
});

it("changes and saves the mode, and System restores native OS following", () => {
  const root = document.createElement("div");
  const storage = { getItem: vi.fn(() => "system"), setItem: vi.fn() };
  const { result } = renderHook(() => useAppearance({ root, storage }));
  act(() => result.current.change({ currentTarget: { value: "dark" } } as ChangeEvent<HTMLSelectElement>));
  expect(result.current.preference).toBe("dark");
  expect(root.style.colorScheme).toBe("dark");
  expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "dark");
  act(() => result.current.change({ currentTarget: { value: "system" } } as ChangeEvent<HTMLSelectElement>));
  expect(root.style.colorScheme).toBe("light dark");
  expect(storage.setItem).toHaveBeenLastCalledWith("om.appearance.v1", "system");
});

it("keeps the selected mode usable when persistence fails", () => {
  const root = document.createElement("div");
  const storage = { getItem: () => null, setItem() { throw new Error("quota"); } };
  const { result } = renderHook(() => useAppearance({ root, storage }));
  act(() => result.current.change({ currentTarget: { value: "light" } } as ChangeEvent<HTMLSelectElement>));
  expect(result.current.preference).toBe("light");
  expect(root.style.colorScheme).toBe("light");
  act(() => result.current.change({ currentTarget: { value: "invalid" } } as ChangeEvent<HTMLSelectElement>));
  expect(result.current.preference).toBe("system");
});
