import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const themeIds = ["glass", "neumorphic", "modern-premium", "mono", "om-ink"];
type Tokens = Record<string, string>;
// Fixture reads only. Array/regex callbacks below retain their native callback signatures.
const readCss = ({ name }: { name: string }) => readFileSync(new URL(`../src/themes/${name}.css`, import.meta.url), "utf8");
/** Read leaf blocks from our deliberately restricted CSS, including media/support overrides. O(n). */
function blocks({ css }: { css: string }) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selector: match[1]!.trim(), body: match[2]!,
    tokens: Object.fromEntries([...match[2]!.matchAll(/--jini-([\w-]+):\s*([^;]+);/g)].map(value => [value[1]!, value[2]!.trim()])),
  }));
}
/** Model Jini's installed scheme aliases before resolving one level of authored var(). O(1). */
function palette({ tokens, scheme }: { tokens: Tokens; scheme: string }): Tokens {
  const aliases = ["bg", "surface", "text", "muted", "border", "primary", "primary-ink"];
  return { ...Object.fromEntries(aliases.map(role => [role, tokens[`theme-${scheme}-${role}`]!])), ...tokens };
}
/** Resolve a direct alias; missing inputs remain assertion failures, never contrast exemptions. */
function value({ tokens, role }: { tokens: Tokens; role: string }): string {
  const raw = tokens[role]; expect(raw, `missing ${role}`).toBeDefined();
  return raw!.replace(/^var\(--jini-([\w-]+)\)$/, (_match, alias: string) => tokens[alias]!);
}
/** Only authored hex and rgb syntax is admitted; unsupported formats fail instead of skipping pairs. */
function rgba({ css }: { css: string }): number[] {
  if (css.startsWith("rgb(")) return css.match(/[\d.]+/g)!.map(Number);
  expect(css).toMatch(/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i);
  const hex = css.length === 4 ? css.slice(1).split("").map(digit => digit + digit).join("") : css.slice(1);
  const channels = hex.match(/../g)!.map(channel => parseInt(channel, 16));
  return [channels[0]!, channels[1]!, channels[2]!, (channels[3] ?? 255) / 255];
}
function over({ css, backdrop }: { css: string; backdrop: number[] }): number[] {
  const color = rgba({ css }); const alpha = color[3] ?? 1;
  return color.slice(0, 3).map((channel, index) => channel * alpha + backdrop[index]! * (1 - alpha));
}
function luminance({ color }: { color: number[] }): number {
  const linear = color.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
function contrast({ foreground, background, label, minimum = 4.5 }: { foreground: string; background: number[]; label: string; minimum?: number }): void {
  const a = luminance({ color: over({ css: foreground, backdrop: background }) }); const b = luminance({ color: background });
  expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), label).toBeGreaterThanOrEqual(minimum);
}
const states = themeIds.flatMap(id => blocks({ css: readCss({ name: id }) }).slice(0, 2).map((block, index) => ({
  id, scheme: index === 0 ? "light" : "dark", ...block,
})));
const accents = blocks({ css: readCss({ name: "accents" }) });

/** Check the actual foreground/background roles, with alpha surfaces over each canvas stop. */
function surfacePairs({ tokens, canvas, label }: { tokens: Tokens; canvas: number[]; label: string }): void {
  const pairs = [["panel-text", "panel-bg"], ["panel-muted", "panel-bg"], ["link", "panel-bg"], ["text", "control-bg"], ["metric-text", "metric-bg"], ["metric-muted", "metric-bg"], ["nav-active-text", "nav-active-bg"], ["primary-ink", "primary"], ["rail-text", "rail-bg"], ["rail-muted", "rail-bg"], ["tab-active-text", "tab-active-bg"]];
  for (const [foreground, background] of pairs) {
    contrast({ foreground: tokens[foreground!]!, background: over({ css: tokens[background!]!, backdrop: canvas }), label: `${label}/${foreground}/${background}` });
  }
  for (const role of ["muted", "text-faint"]) contrast({ foreground: tokens[role]!, background: canvas, label: `${label}/${role}` });
  for (const role of ["panel-bg", "control-bg"]) {
    contrast({ foreground: tokens["control-border"]!, background: over({ css: tokens[role]!, backdrop: canvas }), minimum: 3, label: `${label}/control/${role}` });
    contrast({ foreground: tokens["accent-strong"]!, background: over({ css: tokens[role]!, backdrop: canvas }), minimum: 3, label: `${label}/focus/${role}` });
  }
}
/** Check accent combinations and Premium's brightest textured panel as well as its flat base. */
function panelPairs({ tokens, canvas, scheme, label }: { tokens: Tokens; canvas: number[]; scheme: string; label: string }): void {
  const panel = over({ css: tokens["panel-bg"]!, backdrop: canvas });
  const backgrounds = [panel, ...(tokens["panel-texture"]!.match(/rgb\([^)]+\)/g) ?? []).map(css => over({ css, backdrop: panel }))];
  const foregrounds = ["panel-text", "panel-muted", "link"].map(role => tokens[role]!);
  const strongAccents = accents.filter(block => block.selector.includes(`"${scheme}"`)).map(block => block.tokens["accent-strong"]!);
  for (const background of backgrounds) {
    for (const foreground of [...foregrounds, ...strongAccents]) contrast({ foreground, background, label: `${label}/${foreground}` });
  }
}

it("uses WCAG luminance and composites translucent surfaces before measuring", () => {
  expect(luminance({ color: [255, 255, 255] })).toBe(1);
  expect(luminance({ color: [0, 0, 0] })).toBe(0);
  expect(luminance({ color: [255, 0, 0] })).toBeCloseTo(.2126);
  expect(over({ css: "rgb(255 255 255 / .55)", backdrop: [0, 0, 0] })).toEqual([140.25, 140.25, 140.25]);
  expect(rgba({ css: "#fff" })).toEqual([255, 255, 255, 1]);
  expect(rgba({ css: "#ffffffcc" })).toEqual([255, 255, 255, .8]);
});
it.each([...themeIds, "accents"])("keeps %s scoped, token-only and within the CSS cap", id => {
  const css = readCss({ name: id }); const parsed = blocks({ css });
  expect(css.trimEnd().split("\n").length).toBeLessThanOrEqual(id === "accents" ? 50 : 110);
  expect(parsed.length).toBeGreaterThanOrEqual(2);
  expect(css).not.toMatch(/!important|url\(|@import|@font-face/);
  if (id !== "accents") expect(parsed.slice(0, 2).map(block => block.selector)).toEqual(["light", "dark"].map(scheme => `:root[data-admin-theme="${id}"][data-color-scheme="${scheme}"]`));
  for (const block of parsed) {
    const attribute = id === "accents" ? 'data-accent="(?:green|blue|violet)"' : `data-admin-theme="${id}"`;
    expect(block.selector).toMatch(new RegExp(`^:root\\[${attribute}\\]\\[data-color-scheme="(?:light|dark)"\\]$`));
    expect(block.body.split(";").map(part => part.trim()).filter(Boolean).every(part => /^--jini-[\w-]+:/.test(part))).toBe(true);
  }
});
it("imports all six themes once, with accents last and no missing Quiet import", () => {
  expect(readCss({ name: "index" }).trim().split("\n")).toEqual(["modernist", ...themeIds, "accents"].map(id => `@import "./${id}.css";`));
});
it.each(states)("ships material roles and AA pairs for $id/$scheme", state => {
  const authored = palette(state);
  const tokens = Object.fromEntries(Object.keys(authored).map(role => [role, value({ tokens: authored, role })]));
  const roles = "app-bg shell-bg panel-bg panel-text panel-muted panel-border panel-shadow panel-shadow-inset panel-texture panel-backdrop rail-bg rail-text rail-muted rail-border rail-shadow rail-backdrop overlay-bg overlay-shadow overlay-backdrop control-bg control-border control-shadow control-shadow-hover control-shadow-pressed control-shadow-inset metric-bg metric-text metric-muted metric-border nav-active-bg nav-active-text nav-active-shadow nav-active-indicator tab-bg tab-active-bg tab-active-text tab-radius radius radius-sm radius-lg radius-pill density font-body font-heading font-size-metric font-weight-metric";
  for (const role of roles.split(" ")) expect(tokens[role], role).toBeDefined();
  const base = rgba({ css: tokens.bg! }).slice(0, 3);
  const stops = tokens["app-bg"]!.match(/#[\da-f]{3,8}\b/gi) ?? [tokens.bg!];
  for (const stop of stops) {
    const canvas = over({ css: stop, backdrop: base });
    const label = `${state.id}/${state.scheme}/${stop}`;
    surfacePairs({ tokens, canvas, label }); panelPairs({ tokens, canvas, scheme: state.scheme, label });
  }
});
it.each(accents)("keeps four accent values and readable button ink in $selector", accent => {
  expect(Object.keys(accent.tokens).sort()).toEqual(["accent-soft", "accent-strong", "primary", "primary-ink"]);
  contrast({ foreground: accent.tokens["primary-ink"]!, background: rgba({ css: accent.tokens.primary! }).slice(0, 3), label: accent.selector });
});
it("provides each accent in both schemes without duplicate selectors", () => {
  expect(accents.map(block => block.selector).sort()).toEqual(["green", "blue", "violet"].flatMap(id => ["light", "dark"].map(scheme => `:root[data-accent="${id}"][data-color-scheme="${scheme}"]`)).sort());
});
it("makes all three Glass accessibility fallbacks opaque and disables decorative motion", () => {
  const css = readCss({ name: "glass" }); const parsed = blocks({ css });
  expect(css).toContain("@supports not (backdrop-filter: blur(1px))");
  expect(css).toContain("(prefers-reduced-transparency: reduce), (prefers-contrast: more)");
  expect(css).toContain("(prefers-reduced-motion: reduce)");
  expect(parsed).toHaveLength(8);
  for (const [index, block] of parsed.slice(2, 6).entries()) {
    const panel = index % 2 === 0 ? "#f4f7fb" : "#182030";
    for (const role of ["panel-bg", "rail-bg", "metric-bg"]) expect(block.tokens[role]).toBe(panel);
    for (const role of ["panel-backdrop", "rail-backdrop", "overlay-backdrop"]) expect(block.tokens[role]).toBe("none");
    const original = states[index % 2]!;
    const tokens = palette({ ...original, tokens: { ...original.tokens, ...block.tokens } });
    for (const role of ["panel-text", "panel-muted", "link"]) contrast({ foreground: value({ tokens, role }), background: rgba({ css: panel }).slice(0, 3), label: `fallback ${role}` });
  }
  for (const block of parsed.slice(6)) expect(Object.values(block.tokens)).toEqual(["0ms", "0ms", "0ms"]);
});
