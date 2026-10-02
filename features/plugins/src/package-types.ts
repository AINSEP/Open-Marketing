import type { PluginExtensionDescriptor, PluginSource } from "./types.js";

/** Bounded immutable package view supplied by safe filesystem/archive readers. */
export type PluginPackage = { readonly entries: readonly PluginPackageEntry[] };
/** All paths are package-relative POSIX paths. Links are rejected before any content is read. */
export type PluginPackageEntry = {
  readonly path: string; readonly kind: "file" | "directory" | "symlink" | "hardlink";
  readonly content?: string;
};
/** Server-only validated configuration. Never send this type to an agent. */
export type PluginServer =
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly type: "streamable-http" | "sse"; readonly url: string; readonly headers?: Readonly<Record<string, string>> };
/** Diagnostic paths/IDs contain no package content, secrets or exception messages. */
export type PluginDiagnostic = { readonly code: string; readonly path: string };
/** Explicit allowlist for agent export; references/configuration are absent. */
export type AgentPluginInstructions = {
  readonly pluginId: string; readonly version: string;
  readonly skills: readonly { readonly name: string; readonly description: string; readonly instructions: string }[];
};
/** Inspection separates server data from the agent view and closes invalid entries independently. */
export type PluginPackageInspection = {
  readonly pluginId: string; readonly version: string; readonly extension: PluginExtensionDescriptor;
  readonly servers: Readonly<Record<string, PluginServer>>;
  readonly agent: AgentPluginInstructions; readonly diagnostics: readonly PluginDiagnostic[];
};
/** Test fixture with an independent actual digest; expectedDigest is never proof of trust. */
export type MemoryPluginPackage = {
  readonly source: PluginSource; readonly actualDigest: string; readonly package: PluginPackage; readonly trusted: boolean;
};
