import type { NavigationTarget } from "@open-marketing/contracts";
/** Explicit routes; agent text and arbitrary URLs never become navigation. */
export const ROUTES: Readonly<Record<NavigationTarget, { label: string; description: string; glyph: string }>> = {
  workspaces: { label: "Overview", description: "A clear view of your marketing workspace.", glyph: "◈" },
  creative: { label: "Creative", description: "Turn a brief into creative worth testing.", glyph: "✦" },
  "media-library": { label: "Media", description: "Your originals, renditions, and their provenance.", glyph: "▧" },
  campaigns: { label: "Campaigns", description: "Draft first. Review every spend call before it runs.", glyph: "↗" },
  measure: { label: "Measure", description: "Understand results with clearly attributed evidence.", glyph: "▥" },
  connections: { label: "Connections", description: "Connect accounts through the server.", glyph: "⌁" },
  plugins: { label: "Plugins", description: "Replaceable capabilities with one approval policy.", glyph: "⊞" },
  activity: { label: "Activity", description: "Follow jobs, approvals, and outcomes.", glyph: "≋" },
  settings: { label: "Settings", description: "Workspace controls and generation allowance.", glyph: "⚙" },
};
export const NAVIGATION: readonly NavigationTarget[] = ["workspaces", "creative", "media-library", "campaigns", "measure", "connections", "plugins", "activity", "settings"];
