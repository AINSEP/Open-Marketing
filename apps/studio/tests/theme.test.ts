import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// CSS named and system colors. transparent and currentColor deliberately remain legal.
const namedColors = `aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
  cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen
  darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
  darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
  ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
  ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
  magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
  mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
  seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
  steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen
  accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext
  field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem
  selecteditemtext visitedtext activeborder activecaption appworkspace background buttonhighlight
  buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext infobackground
  infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow
  threedshadow window windowframe windowtext`.trim().split(/\s+/).join("|");
const rawColor = new RegExp(
  `#[\\da-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\s*\\(|(?<![-\\w])(?:${namedColors})(?![-\\w])`,
  "gi",
);

/** Return raw colors from declaration values, including gradients and var() fallbacks.
 * Comments, strings, URLs and selector names are not colors. This cheap source guard
 * handles authored CSS, not escaped/obfuscated CSS or runtime plugin styles.
 * @complexity Linear in stylesheet length; no runtime or external I/O.
 */
function rawColors({ css }: { css: string }): string[] {
  const declarations = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/url\([^)]*\)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi, "")
    .matchAll(/(?:^|[;{])\s*[-\w]+\s*:\s*([^;{}]+)/g);
  const colors: string[] = [];
  for (const declaration of declarations) colors.push(...((declaration[1] ?? "").match(rawColor) ?? []));
  return colors;
}

it.each([
  ".card { color: #fff; border-color: #00c89680 }",
  ".card { background: rgb(0 0 0 / .5) }",
  ".card { background: rgba(0, 0, 0, .5) }",
  ".card { color: hsl(150deg 50% 50%) }",
  ".card { color: hsla(150, 50%, 50%, .5) }",
  ".card { color: hwb(150deg 10% 10%) }",
  ".card { color: lab(50% 10 10) }",
  ".card { color: lch(50% 20 150deg) }",
  ".card { color: oklab(50% .1 .1) }",
  ".card { color: oklch(50% .1 150) }",
  ".card { color: color(display-p3 0 1 0) }",
  ".card { border: 1px solid ReBeCcApUrPlE }",
  ".card { background: linear-gradient(90deg, var(--om-bg), red) }",
  ".card { color: var(--om-text, white) }",
  ".card { box-shadow: 0 1px 2px ButtonFace }",
])("rejects raw colors in component declarations: %s", css => {
  expect(rawColors({ css })).not.toEqual([]);
});

it("allows token colors and CSS keywords without mistaking selectors, comments or assets for colors", () => {
  expect(rawColors({ css: `
    /* color: #fff */
    .red, #fff { color: var(--om-text); background: transparent; border-color: currentColor }
    .card { background: linear-gradient(90deg, var(--om-accent-soft), transparent) }
    .card { color: var(--white); content: "red"; background-image: url("icons.svg#fff") }
  ` })).toEqual([]);
});

it("finds raw colors after valid declarations and across nested rules", () => {
  expect(rawColors({ css: `
    .card { color: var(--om-text); padding: 0; background: var(--om-bg, #fff) }
    @media (max-width: 650px) { .card { border-color: red; color: var(--om-text) } }
  ` })).toEqual(["#fff", "red"]);
});

it("keeps raw colors in theme files only across all studio component stylesheets", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const stylesheets = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter(path => path.endsWith(".css") && !path.startsWith(`themes${sep}`));
  expect(stylesheets.length).toBeGreaterThan(0);
  const violations: { path: string; colors: string[] }[] = [];
  for (const path of stylesheets) {
    const colors = rawColors({ css: readFileSync(join(root, path), "utf8") });
    if (colors.length > 0) violations.push({ path, colors });
  }
  expect(violations).toEqual([]);
});
