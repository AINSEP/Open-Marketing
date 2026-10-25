import { useEffect, useState } from "react";
import type { ChangeEventHandler } from "react";
import { resolveColorScheme } from "@jini-ai/ui/theme";
import type { MatchMediaPort } from "@jini-ai/ui/theme";

export type ModePreference = "system" | "light" | "dark";
export type AdminThemeId = "modernist";
/** Browser capabilities are supplied by composition; tests use the same small host. */
export interface AppearanceHost {
  readonly root: Pick<HTMLElement, "setAttribute"> | null;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  readonly matchMedia?: MatchMediaPort | null;
}

function parsePreference(required: { value: unknown }): ModePreference {
  if (required.value === "system" || required.value === "dark") return required.value;
  return "light";
}

/** Only the shipped theme is admitted. R2 extends this when Quiet ships. */
function parseTheme(required: { value: unknown }): AdminThemeId {
  if (required.value === "modernist") return required.value;
  return "modernist";
}

function readStored(required: { storage: AppearanceHost["storage"]; key: string }): string | null {
  try { return required.storage?.getItem(required.key) ?? null; }
  catch { return null; }
}

function saveStored(required: { storage: AppearanceHost["storage"]; key: string; value: string }): void {
  try { required.storage?.setItem(required.key, required.value); }
  catch { /* A blocked browser store leaves this session's selection usable. */ }
}

function setScheme(required: { host: AppearanceHost; preference: ModePreference }): void {
  const preference = required.preference === "system" && !required.host.matchMedia ? "light" : required.preference;
  const scheme = resolveColorScheme({ preference }, { matchMedia: required.host.matchMedia ?? undefined });
  required.host.root?.setAttribute("data-color-scheme", scheme);
}

/** Restore validated device preferences before mounting; no subscription is created here.
 * @returns Saved theme and scheme preference, defaulting to Modernist/Light.
 */
export function applyAppearance(required: AppearanceHost): { theme: AdminThemeId; scheme: ModePreference } {
  const theme = parseTheme({ value: readStored({ storage: required.storage, key: "om.admin-theme.v1" }) });
  const scheme = parsePreference({ value: readStored({ storage: required.storage, key: "om.appearance.v1" }) });
  required.root?.setAttribute("data-admin-theme", theme);
  setScheme({ host: required, preference: scheme });
  return { theme, scheme };
}

/** Settings state owns persistence; only System listens for OS changes, with paired cleanup.
 * Effects touch only the injected root, storage and media port. Work is constant per change.
 */
export function useAppearance(required: AppearanceHost): {
  preference: ModePreference; theme: AdminThemeId;
  change: ChangeEventHandler<HTMLSelectElement>; changeTheme: ChangeEventHandler<HTMLSelectElement>;
} {
  const [preference, setPreference] = useState(() => parsePreference({ value: readStored({ storage: required.storage, key: "om.appearance.v1" }) }));
  const [theme, setTheme] = useState(() => parseTheme({ value: readStored({ storage: required.storage, key: "om.admin-theme.v1" }) }));
  const { root, matchMedia } = required;
  useEffect(() => {
    root?.setAttribute("data-admin-theme", theme);
    const refresh = (): void => setScheme({ host: { root, storage: null, matchMedia }, preference });
    refresh();
    if (preference !== "system" || !matchMedia) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", refresh);
    return () => media.removeEventListener?.("change", refresh);
  }, [root, matchMedia, preference, theme]);
  // Native React event ABI is narrowed here; storage never supplies unchecked CSS or attributes.
  const change: ChangeEventHandler<HTMLSelectElement> = event => {
    const next = parsePreference({ value: event.currentTarget.value });
    setPreference(next);
    saveStored({ storage: required.storage, key: "om.appearance.v1", value: next });
  };
  const changeTheme: ChangeEventHandler<HTMLSelectElement> = event => {
    const next = parseTheme({ value: event.currentTarget.value });
    setTheme(next);
    saveStored({ storage: required.storage, key: "om.admin-theme.v1", value: next });
  };
  return { preference, theme, change, changeTheme };
}
