import { addonNavigationTargetSchema } from "@open-marketing/contracts";
import type { AddonNavigationTarget, NavigationTarget, StudioNavigationTarget } from "@open-marketing/contracts";
/**
 * Icons: Lucide Static 1.61.0, ISC (Feather-derived icons retain MIT; notices below).
 * Sources relative to ADS-memory/.local-artifacts/codex-runs/2026-10-24-icons/sets/
 * Overview: lucide-static-1.61.0/package/icons/layout-dashboard.svg
 * Creative: lucide-static-1.61.0/package/icons/palette.svg
 * Media: lucide-static-1.61.0/package/icons/images.svg
 * Campaigns: lucide-static-1.61.0/package/icons/megaphone.svg
 * Measure: lucide-static-1.61.0/package/icons/chart-no-axes-combined.svg
 * Activity: lucide-static-1.61.0/package/icons/activity.svg
 * Plugins: lucide-static-1.61.0/package/icons/puzzle.svg
 * Agent Plugins: lucide-static-1.61.0/package/icons/bot.svg
 * Skills: lucide-static-1.61.0/package/icons/book-open.svg
 * Integrations: lucide-static-1.61.0/package/icons/plug.svg
 * Connections: lucide-static-1.61.0/package/icons/cable.svg
 * Settings: lucide-static-1.61.0/package/icons/settings-2.svg
 * Rail toggle: lucide-static-1.61.0/package/icons/panel-left-close.svg
 * Assistant FAB: lucide-static-1.61.0/package/icons/sparkles.svg
 * Group chevron: lucide-static-1.61.0/package/icons/chevron-down.svg
 * These are authored constants, never plugin or server input.
 */
/*
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const NAV_ICONS = {
  "overview": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\" />\n  <rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\" />\n  <rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\" />\n  <rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\" />",
  "creative": "<path d=\"M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z\" />\n  <circle cx=\"13.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\" />\n  <circle cx=\"17.5\" cy=\"10.5\" r=\".5\" fill=\"currentColor\" />\n  <circle cx=\"6.5\" cy=\"12.5\" r=\".5\" fill=\"currentColor\" />\n  <circle cx=\"8.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />",
  "media": "<path d=\"m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16\" />\n  <path d=\"M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2\" />\n  <circle cx=\"13\" cy=\"7\" r=\"1\" fill=\"currentColor\" />\n  <rect x=\"8\" y=\"2\" width=\"14\" height=\"14\" rx=\"2\" />",
  "campaigns": "<path d=\"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z\" />\n  <path d=\"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14\" />\n  <path d=\"M8 6v8\" />",
  "measure": "<path d=\"M12 16v5\" />\n  <path d=\"M16 14.639V21\" />\n  <path d=\"M20 10.656V21\" />\n  <path d=\"m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15\" />\n  <path d=\"M4 18.463V21\" />\n  <path d=\"M8 14.656V21\" />",
  "activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />",
  "plugins": "<path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\" />",
  "agentPlugins": "<path d=\"M12 8V4H8\" />\n  <rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\" />\n  <path d=\"M2 14h2\" />\n  <path d=\"M20 14h2\" />\n  <path d=\"M15 13v2\" />\n  <path d=\"M9 13v2\" />",
  "skills": "<path d=\"M12 5v16\" />\n  <path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />",
  "integrations": "<path d=\"M12 22v-5\" />\n  <path d=\"M15 8V2\" />\n  <path d=\"M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z\" />\n  <path d=\"M9 8V2\" />",
  "connections": "<path d=\"M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z\" />\n  <path d=\"M17 21v-2\" />\n  <path d=\"M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10\" />\n  <path d=\"M21 21v-2\" />\n  <path d=\"M3 5V3\" />\n  <path d=\"M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z\" />\n  <path d=\"M7 5V3\" />",
  "settings": "<path d=\"M14 17H5\" />\n  <path d=\"M19 7h-9\" />\n  <circle cx=\"17\" cy=\"17\" r=\"3\" />\n  <circle cx=\"7\" cy=\"7\" r=\"3\" />",
  "rail": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" />\n  <path d=\"M9 3v18\" />\n  <path d=\"m16 15-3-3 3-3\" />",
  "assistant": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" />\n  <path d=\"M20 2v4\" />\n  <path d=\"M22 4h-4\" />\n  <circle cx=\"4\" cy=\"20\" r=\"2\" />",
  "chevron": "<path d=\"m6 9 6 6 6-6\" />"
} as const;

/** Explicit routes; agent text and arbitrary URLs never become navigation. */
export const ROUTES: Readonly<Record<StudioNavigationTarget, { label: string; description: string; icon: string; soon?: boolean }>> = {
  workspaces: { label: "Overview", description: "A clear view of your marketing workspace.", icon: NAV_ICONS.overview },
  creative: { label: "Creative", description: "Turn a brief into creative worth testing.", icon: NAV_ICONS.creative, soon: true },
  "media-library": { label: "Media", description: "Your originals, renditions, and their provenance.", icon: NAV_ICONS.media },
  campaigns: { label: "Campaigns", description: "Draft first. Review every spend call before it runs.", icon: NAV_ICONS.campaigns },
  measure: { label: "Measure", description: "Understand results with clearly attributed evidence.", icon: NAV_ICONS.measure, soon: true },
  connections: { label: "Connections", description: "Connect accounts through the server.", icon: NAV_ICONS.connections },
  plugins: { label: "Plugins", description: "Replaceable capabilities with one approval policy.", icon: NAV_ICONS.plugins },
  activity: { label: "Activity", description: "Follow jobs, approvals, and outcomes.", icon: NAV_ICONS.activity },
  settings: { label: "Settings", description: "Workspace controls and generation allowance.", icon: NAV_ICONS.settings },
  "/addons/plugins": { label: "Plugins", description: "Upload and manage your workspace plugins.", icon: NAV_ICONS.plugins },
  "/addons/agent-plugins": { label: "Agent Plugins", description: "Manage assistant capabilities and their skills.", icon: NAV_ICONS.agentPlugins },
  "/addons/skills": { label: "Skills", description: "Upload and manage instructions for the assistant.", icon: NAV_ICONS.skills },
  "/addons/integrations": { label: "Integrations", description: "Save access tokens and manage connected accounts.", icon: NAV_ICONS.integrations },
};
export const NAVIGATION: readonly NavigationTarget[] = ["workspaces", "creative", "media-library", "campaigns", "measure", "connections", "activity", "settings"];
export const ADDON_NAVIGATION: readonly AddonNavigationTarget[] = addonNavigationTargetSchema.options;
/** Narrow shared route names without admitting arbitrary paths. */
export function isAddonTarget(required: { target: StudioNavigationTarget }): required is { target: AddonNavigationTarget } {
  return addonNavigationTargetSchema.safeParse(required.target).success;
}

/** Navigation stays literal and preview links remain reachable, including SOON rows. */
export const NAV_GROUPS: readonly { label: string; targets: readonly StudioNavigationTarget[] }[] = [
  { label: "WORKSPACE", targets: ["workspaces", "creative", "media-library", "campaigns", "measure", "activity"] },
  { label: "ADD-ONS", targets: ["/addons/plugins", "/addons/agent-plugins", "/addons/skills", "/addons/integrations"] },
  { label: "SYSTEM", targets: ["connections", "settings"] },
];
