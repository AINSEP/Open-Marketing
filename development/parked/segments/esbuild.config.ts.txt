import { build } from "esbuild";

await Promise.all([
  build({ bundle: true, entryPoints: ["./src/index.ts"], format: "esm", outdir: "./dist", outExtension: { ".js": ".mjs" }, packages: "external", platform: "neutral", target: "es2024" }),
  build({ bundle: true, entryPoints: ["./src/index.ts"], format: "cjs", outdir: "./dist", outExtension: { ".js": ".cjs" }, packages: "external", platform: "node", target: "node24" }),
]);
