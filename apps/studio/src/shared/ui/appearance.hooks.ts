import { useEffect, useState } from "react";
import type { ChangeEventHandler } from "react";
import { resolveColorScheme } from "@jini-ai/ui/theme";
import type { MatchMediaPort } from "@jini-ai/ui/theme";
import { THEMES, ACCENTS } from "../../themes/registry.js";
import type { AdminThemeId, AdminAccentId, AdminThemeScheme } from "../../themes/registry.js";
export type { AdminThemeId } from "../../themes/registry.js";

export type ModePreference = "system" | "light" | "dark";
/** Browser capabilities are supplied by composition; tests use the same small host. */
export interface AppearanceHost {
  readonly root: Pick<HTMLElement, "setAttribute" | "removeAttribute"> | null;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  readonly matchMedia?: MatchMediaPort | null;
}

function parsePreference(required: { value: unknown }): ModePreference {
  if (required.value === "system" || required.value === "dark") return required.value;
  return "light";
}

/** Removed or unknown theme IDs resolve to Modern. */
function parseTheme(required: { value: unknown }): AdminThemeId {
  return THEMES.find(theme => theme.id === required.value)?.id ?? "modernist";
}

function parseAccent(required: { value: unknown }): AdminAccentId {
  return typeof required.value === "string" && Object.hasOwn(ACCENTS, required.value) ? required.value as AdminAccentId : "default";
}
/** Device JSON is capped before parsing; retain only shipped themes and preset accents.
 * @complexity O(1) time/space: at most 1,024 characters and five keys. Malformed data defaults.
 */
function readAccents(required: AppearanceHost): Partial<Record<AdminThemeId, AdminAccentId>> {
  const stored = readStored({ storage: required.storage, key: "om.admin-accents.v1" });
  if (!stored || stored.length > 1024) return {};
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(THEMES.map(theme => [theme.id, parseAccent({ value: (value as Record<string, unknown>)[theme.id] })]));
  } catch { return {}; }
}

/** Theme default relinquishes the override; CSS handles subsequent System scheme flips. */
function setAccent(required: { root: AppearanceHost["root"]; accent: AdminAccentId }): void {
  if (required.accent === "default") required.root?.removeAttribute("data-accent");
  else required.root?.setAttribute("data-accent", required.accent);
}

function readStored(required: { storage: AppearanceHost["storage"]; key: string }): string | null {
  try { return required.storage?.getItem(required.key) ?? null; }
  catch { return null; }
}

function saveStored(required: { storage: AppearanceHost["storage"]; key: string; value: string }): void {
  try { required.storage?.setItem(required.key, required.value); }
  catch { /* A blocked browser store leaves this session's selection usable. */ }
}

function setScheme(required: { host: AppearanceHost; preference: ModePreference }): AdminThemeScheme {
  const preference = required.preference === "system" && !required.host.matchMedia ? "light" : required.preference;
  const scheme = resolveColorScheme({ preference }, { matchMedia: required.host.matchMedia ?? undefined });
  required.host.root?.setAttribute("data-color-scheme", scheme);
  return scheme;
}

/** Restore validated device preferences before mounting; no subscription is created here.
 * @returns Saved theme, scheme preference and accent, defaulting to Modern/Light/theme default.
 * @example applyAppearance({ root, storage, matchMedia })
 */
export function applyAppearance(required: AppearanceHost): { theme: AdminThemeId; scheme: ModePreference; accent: AdminAccentId } {
  const theme = parseTheme({ value: readStored({ storage: required.storage, key: "om.admin-theme.v1" }) });
  const scheme = parsePreference({ value: readStored({ storage: required.storage, key: "om.appearance.v1" }) });
  const accent = readAccents(required)[theme] ?? "default";
  required.root?.setAttribute("data-admin-theme", theme);
  setAccent({ root: required.root, accent });
  setScheme({ host: required, preference: scheme });
  return { theme, scheme, accent };
}

/** Settings state owns persistence; only System listens for OS changes, with paired cleanup.
 * Effects touch only the injected root, storage and media port. Work is constant per change.
 */
export function useAppearance(required: AppearanceHost): {
  preference: ModePreference; theme: AdminThemeId; scheme: AdminThemeScheme; accent: AdminAccentId;
  accents: Partial<Record<AdminThemeId, AdminAccentId>>; themes: typeof THEMES;
  change: ChangeEventHandler<HTMLSelectElement>; changeTheme: ChangeEventHandler<HTMLInputElement | HTMLSelectElement>;
  changeAccent: ChangeEventHandler<HTMLInputElement>;
} {
  const [preference, setPreference] = useState(() => parsePreference({ value: readStored({ storage: required.storage, key: "om.appearance.v1" }) }));
  const [theme, setTheme] = useState(() => parseTheme({ value: readStored({ storage: required.storage, key: "om.admin-theme.v1" }) }));
  const [accents, setAccents] = useState(() => readAccents(required));
  const [scheme, setResolvedScheme] = useState<AdminThemeScheme>("light");
  const accent = accents[theme] ?? "default";
  const { root, matchMedia } = required;
  useEffect(() => {
    root?.setAttribute("data-admin-theme", theme);
    setAccent({ root, accent });
  }, [root, theme, accent]);
  useEffect(() => {
    const refresh = (): void => setResolvedScheme(setScheme({ host: { root, storage: null, matchMedia }, preference }));
    refresh();
    if (preference !== "system" || !matchMedia) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", refresh);
    return () => media.removeEventListener?.("change", refresh);
  }, [root, matchMedia, preference]);
  // Native React event ABI is narrowed here; storage never supplies unchecked CSS or attributes.
  const change: ChangeEventHandler<HTMLSelectElement> = event => {
    const next = parsePreference({ value: event.currentTarget.value });
    setPreference(next);
    saveStored({ storage: required.storage, key: "om.appearance.v1", value: next });
  };
  const changeTheme: ChangeEventHandler<HTMLInputElement | HTMLSelectElement> = event => {
    const next = parseTheme({ value: event.currentTarget.value });
    setTheme(next);
    saveStored({ storage: required.storage, key: "om.admin-theme.v1", value: next });
  };
  const changeAccent: ChangeEventHandler<HTMLInputElement> = event => {
    const next = { ...accents, [theme]: parseAccent({ value: event.currentTarget.value }) };
    setAccents(next);
    saveStored({ storage: required.storage, key: "om.admin-accents.v1", value: JSON.stringify(next) });
  };
  return { preference, theme, scheme, accent, accents, themes: THEMES, change, changeTheme, changeAccent };
}
