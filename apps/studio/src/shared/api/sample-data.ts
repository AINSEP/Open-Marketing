import type { AddonSummary, CredentialCard, ConfirmationCard, ClockPort, MailProviderSettings } from "@open-marketing/contracts";
import type { StudioSnapshot } from "./types.js";

/** Creative/media fixtures: costs are observations, including charge evidence on failure. */
const creativeMediaSamples: NonNullable<StudioSnapshot["pages"]>["creative"] = {
  generations: [
    { id: "generate-brief", title: "The morning ritual", brief: "Warm light, a quieter start. One square image.", status: "review", quote: { minorUnits: 80, currency: "USD" }, estimated: { minorUnits: 80, currency: "USD" }, actual: null, costEvidence: "Quote recorded; generation has not been dispatched.", allowanceClassification: "within_allowance", approvalCardId: "sample-generation" },
    { id: "generate-over", title: "A complete launch collection", brief: "A set of images for the launch flight.", status: "review", quote: { minorUnits: 1200, currency: "USD" }, estimated: { minorUnits: 1200, currency: "USD" }, actual: null, costEvidence: "Server assessment: quote exceeds the daily allowance.", allowanceClassification: "over_allowance", approvalCardId: "sample-generation-over" },
    { id: "generate-quote-unknown", title: "A cinematic variation", brief: "Explore a landscape image; cost is not yet quoted.", status: "review", quote: null, estimated: null, actual: null, costEvidence: "No bounded quote available; an exact approval is required.", allowanceClassification: "unknown_cost", approvalCardId: "sample-generation-unknown" },
    { id: "generate-pending", title: "Small details, big difference", brief: "A material study for the square placement.", status: "pending", quote: { minorUnits: 80, currency: "USD" }, estimated: { minorUnits: 80, currency: "USD" }, actual: null, costEvidence: "Reservation retained while the server polls the operation.", allowanceClassification: "within_allowance", approvalCardId: null },
    { id: "generate-failed", title: "Evening texture", brief: "A soft evening palette.", status: "failed", quote: { minorUnits: 80, currency: "USD" }, estimated: { minorUnits: 80, currency: "USD" }, actual: { minorUnits: 80, currency: "USD" }, costEvidence: "Generation failed after a recorded charge. No refund confirmed.", allowanceClassification: "within_allowance", approvalCardId: null },
    { id: "generate-unknown", title: "Window light", brief: "A second lighting study.", status: "unknown", quote: { minorUnits: 80, currency: "USD" }, estimated: { minorUnits: 80, currency: "USD" }, actual: null, costEvidence: "Timed out; charge and output remain unknown. Await reconciliation.", allowanceClassification: "within_allowance", approvalCardId: null },
  ],
  assets: [
    { id: "asset-morning", title: "Morning light / original", dimensions: "1600 × 1600", originalId: null, crop: null, provenance: "Generated from the morning brief · operation sample-generate-00 · rights recorded.", cost: { minorUnits: 80, currency: "USD" }, costEvidence: "Actual charge recorded once on the original.", importEvidence: "Repeated import matched the content digest; reused this asset without duplicating cost." },
    { id: "asset-morning-crop", title: "Morning light / landscape crop", dimensions: "1200 × 628", originalId: "asset-morning", crop: "Landscape placement · centered crop · original bytes preserved.", provenance: "Rendition of asset-morning; inherits its rights and generation provenance.", cost: null, costEvidence: "Cost linked to the original; no separate charge observation.", importEvidence: "Non-destructive rendition; the original remains available." },
    { id: "asset-detail", title: "A considered detail / imported", dimensions: "1920 × 1080", originalId: null, crop: null, provenance: "Owner-supplied product photo · usage rights recorded at import.", cost: null, costEvidence: "No generation cost observation for this imported photo.", importEvidence: "New content digest; imported once." },
  ],
};

/** Campaign/settings fixtures are server decisions, never browser eligibility calculations. */
const campaignSettingsSamples: NonNullable<StudioSnapshot["pages"]>["campaigns"] = {
  drafts: [
    { id: "spring-ritual", title: "The ritual starts here", status: "paused", review: "ready", reasons: ["Cap, account scope and creative set verified for this exact call."], approvalCardId: "sample-spend" },
    { id: "discovery", title: "A moment of discovery", status: "paused", review: "blocked", reasons: ["Cap evidence expired.", "Selected account is outside the workspace scope.", "Creative set needs rights review."], approvalCardId: null },
    { id: "weekend", title: "Weekend ritual", status: "paused", review: "unavailable", reasons: ["Account review is unavailable; request fresh server evidence."], approvalCardId: null },
  ],
  halts: [
    { id: "halt-pending", account: "Launch account", localBarrier: "blocked", remoteStop: "pending", detail: "Local dispatch is blocked. Remote pause requested; ads may still be serving.", operationId: "sample-halt-01", auditId: "audit-halt-01" },
    { id: "halt-partial", account: "Discovery account", localBarrier: "blocked", remoteStop: "partial", detail: "Two placements paused; one remote placement remains unconfirmed.", operationId: "sample-halt-02", auditId: "audit-halt-02" },
    { id: "halt-unknown", account: "Regional account", localBarrier: "blocked", remoteStop: "unknown", detail: "Transport ended without a stop receipt. Remote serving is unknown.", operationId: "sample-halt-03", auditId: "audit-halt-03" },
    { id: "halt-stopped", account: "Archive account", localBarrier: "blocked", remoteStop: "stopped", detail: "Remote pause confirmed by readback.", operationId: "sample-halt-04", auditId: "audit-halt-04" },
  ],
  allowances: [
    { id: "image-generation", title: "Image generation allowance", daily: { minorUnits: 1000, currency: "USD" }, used: { minorUnits: 80, currency: "USD" }, reserved: { minorUnits: 160, currency: "USD" }, remaining: { minorUnits: 760, currency: "USD" }, timezone: "America/Los_Angeles", reset: "Resets at owner-local midnight. Timezone edits take effect at the next rollover.", revision: "Revision 3 recorded · daily amount unchanged · timezone change deferred until rollover." },
    { id: "paid-sending", title: "Paid-sending allowance", daily: { minorUnits: 500, currency: "USD" }, used: { minorUnits: 0, currency: "USD" }, reserved: { minorUnits: 0, currency: "USD" }, remaining: { minorUnits: 500, currency: "USD" }, timezone: "America/Los_Angeles", reset: "Sample daily setting; authoritative paid-sending reset semantics await server integration.", revision: "Revision 1 · sample setting only; this grants no ad-spend authority." },
  ],
};

/** Operations fixtures retain source, reconciliation and lost-authority evidence. */
const operationsSamples: NonNullable<StudioSnapshot["pages"]>["operations"] = {
  reports: [
    { id: "report-ledger", title: "Recorded costs", source: "om_ledger", period: "October 12 · owner timezone", freshness: "Recorded through 23:50; one cost settlement pending.", gaps: ["Window-light generation charge unresolved."], restates: null, cac: null, cacReason: "Ledger records costs; no acquisition denominator is available." },
    { id: "report-platform", title: "Platform acquisition report", source: "platform_report", period: "October 12 · platform timezone", freshness: "Received October 13 at 09:00; late conversions may restate totals.", gaps: ["One account report missing."], restates: null, cac: null, cacReason: "Mixed USD/EUR report; CAC unavailable without a declared currency basis." },
    { id: "report-attribution", title: "Verified signup attribution", source: "om_attribution", period: "October 12 · 7-day last-click window", freshness: "Restated October 13 at 10:00 after late verified signups.", gaps: ["Unconsented events excluded."], restates: "report-attribution-v1", cac: { minorUnits: 2400, currency: "USD" }, cacReason: null },
  ],
  connections: [
    { id: "connection-reporting", title: "Reporting account", status: "connected", scope: "Reporting read access only.", recovery: "Server holds credentials; reconnect through its browser flow if access changes." },
    { id: "connection-creative", title: "Creative account", status: "reauthentication_required", scope: "Image generation access expired.", recovery: "Reauthenticate in the server browser flow, then refresh capability status." },
    { id: "connection-sending", title: "Sending account", status: "not_connected", scope: "No sending authority.", recovery: "Connect an account through the server; connection does not grant spend approval." },
  ],
  plugins: [
    { id: "plugin-reporting", title: "Reporting capability", version: "1.0.0", status: "admitted", authority: "Read-only reporting admitted; conversion delivery uses a separate narrow grant.", recovery: "Inspect the server's verified capability summary before use." },
    { id: "plugin-creative", title: "Image capability", version: "1.1.0", status: "update_requires_review", authority: "Updated digest invalidated prior authority; generation unavailable until review.", recovery: "Review the update on the server, then reconnect the creative account." },
    { id: "plugin-sending", title: "Sending capability", version: "1.0.0", status: "revoked", authority: "Authority removed; new dispatches denied.", recovery: "Review installation and admission on the server before restoring access." },
  ],
  measurementGrant: { status: "active", events: ["Verified signup", "Verified trial"], destinations: ["Reporting account"], purposes: ["Acquisition measurement"], detail: "Consent is rechecked at dispatch. This grant cannot change campaigns, export arbitrary data or invoke arbitrary tools." },
  activity: [
    { id: "activity-approval", title: "Launch approval requested", status: "pending", operationId: "sample-launch-01", jobId: null, auditId: "audit-launch-review", detail: "Exact card awaiting a choice; no launch dispatched." },
    { id: "activity-halt", title: "Local halt recorded", status: "pending", operationId: "sample-halt-01", jobId: "job-halt-01", auditId: "audit-halt-01", detail: "Dispatch barrier closed; remote pause receipt pending." },
    { id: "activity-generation", title: "Generation outcome unresolved", status: "unknown", operationId: "sample-generate-window", jobId: "job-generate-window", auditId: "audit-generate-window", detail: "Job awaiting reconciliation; unknown charge is not a free or successful result." },
    { id: "activity-report", title: "Attribution restatement appended", status: "recorded", operationId: "sample-report-02", jobId: "job-report-02", auditId: "audit-report-02", detail: "report-attribution restates report-attribution-v1; prior evidence retained." },
  ],
};

/** Hand-written fixture cards. Policy choices represent what a server would supply. */
export function sampleCards(required: { clock: ClockPort }): readonly ConfirmationCard[] {
  const expiresAt = required.clock.now({}) + 900000;
  return [
    { cardId: "sample-generation", operationId: "sample-generate-01", argumentsDigest: "a".repeat(64), classification: "generation", expiresAt, allowedChoices: ["allow", "allow_chat", "always_allow", "cancel"], arguments: { brief: "A quiet morning, a better ritual", format: "square", count: 1, quotedCost: { minorUnits: 80, currency: "USD" } } },
    { cardId: "sample-spend", operationId: "sample-launch-01", argumentsDigest: "b".repeat(64), classification: "spend", expiresAt, allowedChoices: ["allow", "cancel"], arguments: { campaignId: "spring-ritual", action: "activate", exposure: { minorUnits: 2500, currency: "USD" }, flight: { start: "2026-10-13", end: "2026-10-14" } } },
    { cardId: "sample-generation-unknown", operationId: "sample-generate-02", argumentsDigest: "c".repeat(64), classification: "generation", expiresAt, allowedChoices: ["allow", "cancel"], arguments: { brief: "Explore a cinematic variation", format: "landscape", count: 1, quotedCost: "unknown" } },
    { cardId: "sample-generation-over", operationId: "sample-generate-03", argumentsDigest: "d".repeat(64), classification: "spend", expiresAt, allowedChoices: ["allow", "cancel"], arguments: { brief: "A complete launch collection", format: "square", count: 15, quotedCost: { minorUnits: 1200, currency: "USD" } } },
  ];
}
/** Demonstration read model; its sample label must remain visible on every canvas. */
export function sampleSnapshot(required: { clock: ClockPort }): StudioSnapshot {
  return {
    workspace: "Ritual Studio", mode: "sample",
    metrics: [
      { label: "Library assets", value: "03", detail: "Sample originals and a crop rendition" },
      { label: "Campaign drafts", value: "03", detail: "Paused · no live ad delivery" },
      { label: "Generation remaining", value: "$7.60", detail: "After recorded usage and reservations" },
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
    allowance: { daily: { minorUnits: 1000, currency: "USD" }, remaining: { minorUnits: 760, currency: "USD" }, timezone: "America/Los_Angeles" },
    pages: { creative: creativeMediaSamples, campaigns: campaignSettingsSamples, operations: operationsSamples },
  };
}

/** Disabled integration fixtures stay out of chat discovery; each adapter owns its mutable state. */
export const sampleMailCandidates: MailProviderSettings['candidates'] = [
  { pluginId: 'sample-mail-service', label: 'Sample mail service', status: 'connected' },
  { pluginId: 'sample-mail-relay', label: 'Sample mail relay', status: 'not_connected' },
];
export const sampleIntegrationPlugins: AddonSummary[] = [
  { id: 'sample-oauth-service', name: 'Sample OAuth service', kind: 'agent-plugin', description: 'Sample sign-in service', version: '1', revision: '1', enabled: false },
  { id: 'sample-key-service', name: 'Sample key service', kind: 'agent-plugin', description: 'Sample token service', version: '1', revision: '1', enabled: false },
];
export const sampleCredentialCards: CredentialCard[] = [
  { pluginId: 'sample-oauth-service', target: 'sign-in', title: 'Account sign-in', label: 'Sign in', category: 'Sample', intro: 'Connect an account through secure sign-in.',
    usedFor: [], helpUrl: 'https://example.test/help', helpLabel: 'Sign-in help', baseUrl: 'https://example.test', saveKind: 'oauth', actionSupported: true },
  { pluginId: 'sample-oauth-service', target: 'client', title: 'OAuth client configuration', label: 'Client configuration', category: 'Sample', intro: 'Save your application credentials on the server.',
    usedFor: [], helpUrl: 'https://example.test/help', helpLabel: 'Client setup help', baseUrl: 'https://example.test', saveKind: 'oauth-client', actionSupported: true,
    fields: [{ name: 'clientId', label: 'Client ID', required: true, type: 'string' }, { name: 'tenantId', label: 'Tenant ID', type: 'string' }], secretFields: [{ name: 'clientSecret', label: 'Client secret' }] },
  { pluginId: 'sample-key-service', target: 'access', title: 'Access token', label: 'Token connection', category: 'Sample', intro: 'Save an access token on the server.',
    usedFor: [], keyHint: 'Paste the token from your service account.', helpUrl: 'https://example.test/help', helpLabel: 'Token help', baseUrl: 'https://example.test', saveKind: 'api-key', actionSupported: true,
    secretFields: [{ name: 'token', label: 'Access token', required: true }] },
  { pluginId: 'sample-key-service', target: 'secret', title: 'Plugin secret', label: 'Service secret', category: 'Sample', intro: 'Save a private service key on the server.',
    usedFor: [], helpUrl: 'https://example.test/help', helpLabel: 'Secret help', baseUrl: 'https://example.test', saveKind: 'plugin-secret', actionSupported: true,
    secretFields: [{ name: 'serviceKey', label: 'Service key', required: true }] },
];
