import { navigationTargetSchema, parseBoundary } from "@open-marketing/contracts";
import type { NavigationTarget, Outcome } from "@open-marketing/contracts";
/** OM navigation is structured data; command recognition is validation evidence, never execution evidence. */
export function parseNavCommand(required: { command: string }): NavigationTarget | null {
 const flag = required.command.match(/--target[=\s]+["']?([a-z0-9-]+)/i);
 const positional = required.command.match(/\bnavigate\s+["']?([a-z0-9-]+)/i);
 const parsed = navigationTargetSchema.safeParse(flag?.[1] ?? positional?.[1]);
 return parsed.success ? parsed.data : null;
}
export function navInstruction(required: Record<string, never>): string { return "Use structured OM navigation; report requested/pending until browser completion is acknowledged."; }
