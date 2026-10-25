/** Static, studio-local choices shared by preference validation and Settings previews.
 * Styles are loaded only by themes/index.css; these samples mirror their base scheme blocks.
 */
export type AdminThemeScheme = "light" | "dark";
export interface ThemePreview { readonly bg: string; readonly panel: string; readonly text: string; readonly accent: string }
export const THEMES = [
  { id: "modernist", label: "Modern", preview: {
    light: { bg: "#ffffff", panel: "#ffffff", text: "#18221f", accent: "#00c896" },
    dark: { bg: "#0f1112", panel: "#16181a", text: "#eceeef", accent: "#00b386" },
  } },
  { id: "glass", label: "Glass", preview: {
    light: { bg: "radial-gradient(60% 50% at 15% 10%, #ffffffcc, transparent 70%) fixed, radial-gradient(50% 60% at 85% 20%, #c7d2fe, transparent 70%) fixed, radial-gradient(60% 60% at 70% 90%, #fbcfe8, transparent 70%) fixed, linear-gradient(160deg, #e8eef6, #d6e0ec) fixed", panel: "rgb(255 255 255 / .55)", text: "#161b2b", accent: "#141a2e" },
    dark: { bg: "radial-gradient(60% 50% at 15% 10%, #312e81, transparent 70%) fixed, radial-gradient(50% 60% at 85% 80%, #134e4a, transparent 70%) fixed, linear-gradient(160deg, #0b1020, #111827) fixed", panel: "rgb(17 24 39 / .62)", text: "#eef2f8", accent: "#dce7ef" },
  } },
  { id: "neumorphic", label: "Neumorphic", preview: {
    light: { bg: "#e4e9f0", panel: "#e4e9f0", text: "#2b3442", accent: "#00c896" },
    dark: { bg: "#2a2f36", panel: "#2a2f36", text: "#e3e7ec", accent: "#00b386" },
  } },
  { id: "modern-premium", label: "Modern Premium", preview: {
    light: { bg: "#f7f5f0", panel: "#ffffff", text: "#252721", accent: "#0f5c45" },
    dark: { bg: "#0b0c0e", panel: "#16171b", text: "#ededee", accent: "#34d399" },
  } },
  { id: "mono", label: "Mono", preview: {
    light: { bg: "#f1f1f1", panel: "#ffffff", text: "#0a0a0a", accent: "#0a0a0a" },
    dark: { bg: "#0a0a0a", panel: "#141414", text: "#fafafa", accent: "#f5f5f5" },
  } },
] as const satisfies readonly { id: string; label: string; preview: Record<AdminThemeScheme, ThemePreview> }[];
export type AdminThemeId = (typeof THEMES)[number]["id"];
/** Preset swatches mirror accents.css primary fills; null delegates to each theme. */
export const ACCENTS = {
  default: { id: "default", label: "Theme default", swatch: { light: null, dark: null } },
  green: { id: "green", label: "Green", swatch: { light: "#00c896", dark: "#34d399" } },
  blue: { id: "blue", label: "Blue", swatch: { light: "#2563eb", dark: "#60a5fa" } },
  violet: { id: "violet", label: "Violet", swatch: { light: "#7c3aed", dark: "#a78bfa" } },
} as const;
export type AdminAccentId = keyof typeof ACCENTS;
