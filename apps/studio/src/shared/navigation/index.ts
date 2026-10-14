import { addonNavigationTargetSchema } from "@open-marketing/contracts";
import type { AddonNavigationTarget, NavigationTarget, StudioNavigationTarget } from "@open-marketing/contracts";
/** Explicit routes; agent text and arbitrary URLs never become navigation. */
export const ROUTES: Readonly<Record<StudioNavigationTarget, { label: string; description: string; glyph: string }>> = {
  workspaces: { label: "Overview", description: "A clear view of your marketing workspace.", glyph: "◈" },
  creative: { label: "Creative", description: "Turn a brief into creative worth testing.", glyph: "✦" },
  "media-library": { label: "Media", description: "Your originals, renditions, and their provenance.", glyph: "▧" },
  campaigns: { label: "Campaigns", description: "Draft first. Review every spend call before it runs.", glyph: "↗" },
  measure: { label: "Measure", description: "Understand results with clearly attributed evidence.", glyph: "▥" },
  connections: { label: "Connections", description: "Connect accounts through the server.", glyph: "⌁" },
  plugins: { label: "Plugins", description: "Replaceable capabilities with one approval policy.", glyph: "⊞" },
  activity: { label: "Activity", description: "Follow jobs, approvals, and outcomes.", glyph: "≋" },
  settings: { label: "Settings", description: "Workspace controls and generation allowance.", glyph: "⚙" },
  "/addons/plugins": { label: "Plugins", description: "Upload and manage your workspace plugins.", glyph: "⊞" },
  "/addons/agent-plugins": { label: "Agent Plugins", description: "Manage assistant capabilities and their skills.", glyph: "✦" },
  "/addons/skills": { label: "Skills", description: "Upload and manage instructions for the assistant.", glyph: "▤" },
  "/addons/integrations": { label: "Integrations", description: "Save access tokens and manage connected accounts.", glyph: "⌁" },
};
export const NAVIGATION: readonly NavigationTarget[] = ["workspaces", "creative", "media-library", "campaigns", "measure", "connections", "activity", "settings"];
export const ADDON_NAVIGATION: readonly AddonNavigationTarget[] = addonNavigationTargetSchema.options;
/** Narrow shared route names without admitting arbitrary paths. */
export function isAddonTarget(required: { target: StudioNavigationTarget }): required is { target: AddonNavigationTarget } {
  return addonNavigationTargetSchema.safeParse(required.target).success;
}
