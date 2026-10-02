import { build } from "esbuild";
await Promise.all(["esm", "cjs"].map(format => build({entryPoints: ["src/index.ts"], bundle: true, packages: "external", platform: "neutral", target: "es2024", format: format as "esm" | "cjs", outfile: format === "esm" ? "dist/index.mjs" : "dist/index.cjs"})));
