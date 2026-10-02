import type { Route } from '../../router';

// nav-tools — the generic, DATA-DRIVEN navigation registry for OMChatPane.
//
// One list is the single source of truth for "where the assistant can go".
// Adding a destination = adding one row here; nothing else changes. There are
// deliberately NO hardcoded per-page branches in the tool logic — the agent
// supplies a `target` id and we look it up.
//
// This is the `surface:'frontend'` half of the app-control tool (ADR-013): the
// agent *requests* a navigation; the browser *performs* it via router.navigate.

export interface NavTarget {
  /** Stable id the agent passes as `--target`. */
  id: string;
  /** Human label + synonyms, used to describe the tool to the agent. */
  label: string;
  /** The route to push when this target is chosen. */
  route: Route;
}

// NOTE: every `route` here must resolve to a real destination in router.ts.
export const NAV_TARGET_LIST: NavTarget[] = [
  { id: 'home', label: 'Home', route: { kind: 'home', view: 'home' } },
  { id: 'design-systems', label: 'Design systems (a.k.a. designs, brands)', route: { kind: 'home', view: 'design-systems' } },
  { id: 'projects', label: 'Projects', route: { kind: 'home', view: 'projects' } },
  { id: 'integrations', label: 'Integrations (connectors)', route: { kind: 'home', view: 'integrations' } },
  { id: 'plugins', label: 'Plugins', route: { kind: 'home', view: 'plugins' } },
  { id: 'automations', label: 'Automations (tasks)', route: { kind: 'home', view: 'tasks' } },
  { id: 'marketplace', label: 'Marketplace', route: { kind: 'marketplace' } },
];

export const NAV_TARGETS: Record<string, Route> = Object.fromEntries(
  NAV_TARGET_LIST.map((t) => [t.id, t.route]),
);

// The compact instruction handed to the agent each turn so it knows the
// capability exists and the exact wrapper to call.
export function navInstruction(): string {
  const ids = NAV_TARGET_LIST.map((t) => `  - ${t.id} — ${t.label}`).join('\n');
  return [
    'APP CONTROL: You can navigate the Open Marketing app for the user.',
    'To navigate, run this in your Bash tool (one line):',
    '  "$OM_NODE_BIN" "$OM_BIN" tools app-control navigate --target <id>',
    'Valid <id> values:',
    ids,
    'Only navigate when the user asks to go somewhere. After navigating, confirm in one short sentence.',
  ].join('\n');
}

const VALID_IDS = new Set(NAV_TARGET_LIST.map((t) => t.id));

// Recognize the navigate wrapper inside a Bash command string. Tolerant of
// quoting/pathing: we only need the `... app-control navigate ... --target <id>`
// (or `... navigate <id>`) shape.
export function parseNavCommand(command: string): string | null {
  if (!command || !/app-control|navigate/.test(command)) return null;
  const flag = command.match(/--target[=\s]+["']?([a-z0-9-]+)["']?/i);
  if (flag?.[1] && VALID_IDS.has(flag[1].toLowerCase())) return flag[1].toLowerCase();
  const positional = command.match(/\bnavigate\s+["']?([a-z0-9-]+)["']?/i);
  if (positional?.[1] && VALID_IDS.has(positional[1].toLowerCase())) return positional[1].toLowerCase();
  return null;
}
