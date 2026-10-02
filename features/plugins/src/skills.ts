import { parseDocument } from "yaml";
import { z } from "zod";
import type { AgentPluginInstructions, PluginDiagnostic } from "./package-types.js";

const frontmatterSchema = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), description: z.string().min(1).max(1024) });
/** Config and common credential syntax cannot enter the instruction export. This is a bounded
 * content screen, not proof that arbitrary prose contains no secrets; package authors must not embed them.
 * @complexity O(b) time, O(1) space.
 */
function containsServerData(required: { content: string }): boolean {
  return /mcpServers|\$\{PLUGIN_(ROOT|DATA)\}|(?:authorization|api[_-]?key|password|secret|access[_-]?token)\s*[:=]|Bearer\s+[a-z0-9._-]+/i.test(required.content);
}

/** Discover immediate skill directories only, skip invalid entries with diagnostics. @complexity O(n+b) time/space. */
export function inspectSkills(required: { files: ReadonlyMap<string, string>; diagnostics: PluginDiagnostic[] }): AgentPluginInstructions["skills"] {
  const skills: AgentPluginInstructions["skills"][number][] = [];
  for (const [path, content] of required.files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!match) continue;
    const skill = parseSkill({ name: match[1], content });
    if (skill) skills.push(skill);
    else required.diagnostics.push({ code: "invalid_skill", path });
  }
  return skills;
}

/** Safe YAML frontmatter is metadata only; no MCP/config files are concatenated. @complexity O(b) time/space. */
function parseSkill(required: { name: string; content: string }): AgentPluginInstructions["skills"][number] | null {
  if (required.content.length > 65536 || containsServerData({ content: required.content })) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(required.content);
  if (!match) return null;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length) return null;
    const parsed = frontmatterSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!parsed.success || parsed.data.name !== required.name) return null;
    return { ...parsed.data, instructions: match[2] };
  } catch { return null; }
}
