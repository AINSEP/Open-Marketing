import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { amazonSesTools, sesCredentialSchema } from "../src/index.js";
import { credential } from "./fixtures.js";
const root = new URL("../../", import.meta.url);
/** Fixture-only file boundary; schemas validate inspected metadata. */
function readJson(required: { path: string }): unknown { return JSON.parse(readFileSync(new URL(required.path, root), "utf8")); }
it("keeps matching disabled read capabilities and actual schema fingerprints", () => {
  const cap = z.object({ capabilityId: z.string(), effects: z.array(z.literal("read")), admitted: z.literal(false), schemaFingerprint: z.string() });
  const extension = z.object({ enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(cap),
    credentialCards: z.array(z.object({ saveKind: z.literal("app-credentials"), saveTarget: z.literal("amazon-ses"), secretFields: z.array(z.object({ name: z.string() })) })) });
  const manifest = z.object({ $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), extensions: z.object({ "io.github.ainsep.openmarketing": extension }) }).parse(readJson({ path: "plugin.json" }));
  const declared = z.object({ capabilities: z.array(cap), tools: z.array(z.object({ name: z.string(), effects: z.array(z.literal("read")), capabilityId: z.string() })) }).parse(readJson({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
  expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities).toEqual(declared.capabilities);
  expect(declared.tools).toEqual(amazonSesTools.map(tool => ({ name: tool.name, effects: [tool.effect], capabilityId: tool.capabilityId })));
  const digest = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/commands.ts", root))).digest("hex");
  expect(declared.capabilities.every(item => item.schemaFingerprint === digest)).toBe(true);
  expect(readJson({ path: "mcp.json" })).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  expect(sesCredentialSchema.safeParse(credential).success).toBe(true);
  expect(sesCredentialSchema.safeParse({ ...credential, secretAccessKey: "bad\r\nsecret" }).success).toBe(false);
  const pkg = z.object({ exports: z.record(z.string(), z.unknown()), sideEffects: z.literal(false), dependencies: z.record(z.string(), z.string()) }).parse(readJson({ path: "package.json" }));
  expect(Object.keys(pkg.exports)).toEqual(["."]); expect(pkg.dependencies["@jini-ai/platform"]).toBe("0.6.12");
});
