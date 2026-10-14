import { useState } from "react";
import type { ChangeEventHandler } from "react";

/** Device-local override; System lets CSS follow the OS without media listeners. */
export type ModePreference = "system" | "light" | "dark";
/** Native capabilities shared by browser composition and in-memory test hosts. */
export interface AppearanceHost {
  readonly root: Pick<HTMLElement, "style"> | null;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
}

function parsePreference(required: { value: unknown }): ModePreference {
  if (required.value === "light" || required.value === "dark") return required.value;
  return "system";
}

function readPreference(required: Pick<AppearanceHost, "storage">): ModePreference {
  try { return parsePreference({ value: required.storage?.getItem("om.appearance.v1") }); }
  catch { return "system"; }
}

function setScheme(required: { root: AppearanceHost["root"]; preference: ModePreference }): void {
  if (required.root) required.root.style.colorScheme = required.preference === "system" ? "light dark" : required.preference;
}

/** Read an allowlisted preference and apply it before React mounts. Storage errors select System.
 * @returns The effective preference; only the injected root's color-scheme is changed.
 */
export function applyAppearance(required: AppearanceHost): ModePreference {
  const preference = readPreference(required);
  setScheme({ root: required.root, preference });
  return preference;
}

/** Settings owns the current selection. A failed write leaves the override usable in memory.
 * @returns The preference and a native select handler; no theme registry or subscription.
 */
export function useAppearance(required: AppearanceHost): { preference: ModePreference; change: ChangeEventHandler<HTMLSelectElement> } {
  const [preference, setPreference] = useState<ModePreference>(() => readPreference(required));
  // React's native event ABI is kept at this wrapper; persisted values are allowlisted.
  const change: ChangeEventHandler<HTMLSelectElement> = event => {
    const next = parsePreference({ value: event.currentTarget.value });
    setScheme({ root: required.root, preference: next });
    setPreference(next);
    try { required.storage?.setItem("om.appearance.v1", next); }
    catch { /* Appearance remains usable when browser storage is unavailable. */ }
  };
  return { preference, change };
}
