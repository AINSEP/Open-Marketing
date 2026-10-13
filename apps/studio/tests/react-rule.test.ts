import { it, expect } from "vitest";
import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";

/** Exercises the actual canonical rule; this suite must stay lane-local and does not rewrite it. */
it("the TSX rule catches JSX arrows and nested effect callbacks while accepting extracted handlers", async () => {
  const location = new URL("../../../development/eslint-rules/index.mjs", import.meta.url).href;
  const plugin = (await import(location)).default;
  const linter = new Linter();
  const config = [{ files: ["**/*.tsx"], languageOptions: { parser, parserOptions: { ecmaVersion: "latest" as const, sourceType: "module" as const, ecmaFeatures: { jsx: true } } }, plugins: { om: plugin }, rules: { "om/no-functions-in-component-body": "error" as const } }];
  const arrow = linter.verify("export function View() { return <button onClick={() => {}}>Run</button>; }", config, { filename: "View.tsx" });
  const nested = linter.verify("export function View() { useEffect(() => { function nested() {} }, []); return <div />; }", config, { filename: "View.tsx" });
  const extracted = linter.verify("function onRun() {} export function View() { return <button onClick={onRun}>Run</button>; }", config, { filename: "View.tsx" });
  expect(arrow.filter(message => message.ruleId === "om/no-functions-in-component-body")).toHaveLength(1);
  expect(nested.filter(message => message.ruleId === "om/no-functions-in-component-body")).toHaveLength(2);
  expect(extracted).toEqual([]);
});
