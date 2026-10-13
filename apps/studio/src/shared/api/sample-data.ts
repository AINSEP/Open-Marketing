import type { ConfirmationCard, ClockPort } from "@open-marketing/contracts";
import type { StudioSnapshot } from "./types.js";

/** Hand-written fixture cards. Policy choices represent what a server would supply. */
export function sampleCards(required: { clock: ClockPort }): readonly ConfirmationCard[] {
  const expiresAt = required.clock.now({}) + 900000;
  return [
    { cardId: "sample-generation", operationId: "sample-generate-01", argumentsDigest: "a".repeat(64), classification: "generation", expiresAt, allowedChoices: ["allow", "allow_chat", "always_allow", "cancel"], arguments: { brief: "A quiet morning, a better ritual", format: "square", count: 1, quotedCost: { minorUnits: 80, currency: "USD" } } },
    { cardId: "sample-spend", operationId: "sample-launch-01", argumentsDigest: "b".repeat(64), classification: "spend", expiresAt, allowedChoices: ["allow", "cancel"], arguments: { campaignId: "spring-ritual", action: "activate", exposure: { minorUnits: 2500, currency: "USD" }, flight: { start: "2026-10-13", end: "2026-10-14" } } },
    { cardId: "sample-generation-unknown", operationId: "sample-generate-02", argumentsDigest: "c".repeat(64), classification: "generation", expiresAt, allowedChoices: ["allow", "cancel"], arguments: { brief: "Explore a cinematic variation", format: "landscape", count: 1, quotedCost: "unknown" } },
  ];
}
/** Demonstration read model; its sample label must remain visible on every canvas. */
export function sampleSnapshot(required: { clock: ClockPort }): StudioSnapshot {
  return {
    workspace: "Ritual Studio", mode: "sample",
    metrics: [
      { label: "Creative ready", value: "06", detail: "Sample assets awaiting your review" },
      { label: "Campaign drafts", value: "02", detail: "Paused · no live ad delivery" },
      { label: "Generation remaining", value: "$9.20", detail: "Of a $10.00 daily allowance" },
    ],
    rows: {
      workspaces: [{ id: "brief", title: "Make room for a better morning", detail: "A product launch, from first idea to a measured campaign.", status: "Sample workspace" }],
      creative: [{ id: "morning", title: "The morning ritual", detail: "Warm light · thoughtful details · a quieter start", status: "Brief ready" }, { id: "texture", title: "Small details, big difference", detail: "Material study · square creative · three variations", status: "Draft" }],
      "media-library": [{ id: "asset-1", title: "Morning light / 01", detail: "Original · 1600 × 1600 · rights recorded", status: "Ready" }, { id: "asset-2", title: "A considered detail / 02", detail: "Original · 1920 × 1080 · provenance recorded", status: "Ready" }],
      campaigns: [{ id: "spring", title: "The ritual starts here", detail: "Paused draft · creative set ready for review", status: "Paused" }, { id: "discovery", title: "A moment of discovery", detail: "Paused draft · audience and flight under review", status: "Draft" }],
      measure: [{ id: "report", title: "No live measurement yet", detail: "Connect a reporting capability to see source-labelled results.", status: "Sample" }],
      connections: [{ id: "connection", title: "Account connection", detail: "Connect through the server when the runtime is available.", status: "Not connected" }],
      plugins: [{ id: "plugin", title: "Capability plugins", detail: "Installation, trust, and admission are managed by the server.", status: "Runtime pending" }],
      activity: [{ id: "draft", title: "Campaign saved as a paused draft", detail: "Sample activity · no external dispatch", status: "Recorded" }, { id: "review", title: "Creative ready for review", detail: "Sample activity · review exact arguments in Assistant", status: "Pending" }],
      settings: [{ id: "sandbox", title: "Local sandbox", detail: "Production account writes require the always-on server.", status: "Default" }],
    },
    messages: [{ id: "welcome", role: "assistant", text: "A good campaign starts with a clear idea. I can help shape a brief, organize creative, and review the next step. This is a sample conversation; the agent runtime is not connected." }],
    cards: sampleCards(required),
    allowance: { daily: { minorUnits: 1000, currency: "USD" }, remaining: { minorUnits: 920, currency: "USD" }, timezone: "America/Los_Angeles" },
  };
}
