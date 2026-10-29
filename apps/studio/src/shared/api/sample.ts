import { setConversionSettingsSchema, mailProviderSelectionSchema, pluginSecretQuerySchema, pluginSecretSetSchema, captureEventSchema, recentEventsSchema, addonListRequestSchema, addonSummarySchema, installAddonSchema, setAddonEnabledSchema, uninstallAddonSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, pageQuerySchema } from '@open-marketing/contracts';
import type { AddonSummary, IntegrationSummary, CaptureEvent } from '@open-marketing/contracts';
import { approvalResponseSchema, cancelRunSchema, chatMessageSchema, navigationResultSchema, navigationTargetSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome, RunEvent, NavigationResult, ConfirmationCard, ApprovalResponse } from "@open-marketing/contracts";
import type { StudioApiPort, StudioRun, StudioPayload } from "./types.js";
import type { StudioRuntime } from "./types.js";
import { oauthClientSetSchema, oauthStatusQuerySchema, parseStudioSnapshot } from "./validation.js";
import { sampleSnapshot, sampleIntegrationPlugins, sampleCredentialCards, sampleMailCandidates } from "./sample-data.js";

interface SampleRun { readonly receipt: StudioRun; readonly prompt: string; cancelled: boolean }
function unavailable<T>(): Outcome<T> { return { ok: false, error: { code: "unavailable", message: "Sample run unavailable", retryable: false } }; }
function fixturePayloads(required: { run: SampleRun }): readonly StudioPayload[] {
  const target = navigationTargetSchema.safeParse(required.run.prompt.trim().replace(/^open\s+/i, ""));
  const payloads: StudioPayload[] = [{ type: "status", text: "Sample response · no external tools" }, { type: "message", message: { id: required.run.receipt.runId + "-reply", role: "assistant", text: "Let's start with the audience, the promise, and one clear next step. You can review the sample approvals below, or ask me to open campaigns. No vendor call will run in this preview." } }];
  if (target.success) payloads.push({ type: "navigation", action: { kind: "navigate", actionId: required.run.receipt.runId + "-nav", target: target.data } });
  payloads.push({ type: "status", text: "Sample reply complete" });
  return payloads;
}
function fixtureEvent(required: { runId: string; sequence: number; payload: StudioPayload; last: boolean }): RunEvent {
  return { protocolVersion: 1, eventId: required.runId + "-" + required.sequence, runId: required.runId, sequence: required.sequence, correlationId: required.runId + "-correlation", traceId: required.runId + "-trace", kind: required.last ? "ended" : "delta", payload: JSON.parse(JSON.stringify(required.payload)) };
}
/** In-memory sample adapter, bounded to 100 runs, with no vendor or network effects.
 * Approval means recorded in this preview, never dispatched. Replace at composition only.
 * @example createSampleStudioApi({ runtime })
 * @complexity O(1) lookup; event count and retained runs are bounded.
 */
export function createSampleStudioApi(required: { runtime: StudioRuntime }): StudioApiPort {
  const snapshot = sampleSnapshot({ clock: required.runtime.clock });
  const recent: CaptureEvent[] = [];
  const decisions = new Map<string, string>();
  const runs = new Map<string, SampleRun>();
  const acknowledgements: NavigationResult[] = [];
  return {
    async captureEvent(input) {
      const event = parseBoundary({ schema: captureEventSchema, input: input.event });
      if (!event.ok) return event;
      if (event.value.kind === 'trace') return unavailable();
      if (recent.length === 100) recent.shift();
      recent.push(event.value);
      return { ok: true, value: { status: 'recorded' } };
    },
    async recentEvents() { return parseBoundary({ schema: recentEventsSchema, input: { items: recent } }); },
    async operation() { return unavailable(); },
    async setLeadStage() { return unavailable(); },
    addons: sampleAddons({ runtime: required.runtime }),
    async conversations() { return unavailable(); },
    async conversation() { return unavailable(); },
    async settings() { return unavailable(); },
    async setSettings() { return unavailable(); },
    async snapshot() { return parseStudioSnapshot({ input: snapshot }); },
    async start(input) {
      const message = parseBoundary({ schema: chatMessageSchema, input: input.message });
      if (!message.ok) return message;
      if (message.value.role !== "user" || input.signal.aborted || runs.size >= 100) return unavailable();
      const runId = required.runtime.ids.next({});
      const receipt: StudioRun = { runId, status: "pending", expiresAt: required.runtime.clock.now({}) + 60000 };
      runs.set(runId, { receipt, prompt: message.value.text, cancelled: false });
      return { ok: true, value: receipt };
    },
    async *events(input) {
      const run = runs.get(input.runId);
      if (!run) { yield unavailable(); return; }
      const payloads = fixturePayloads({ run });
      for (let index = input.after; index < payloads.length; index += 1) {
        await required.runtime.timers.wait({ delayMs: 450, signal: input.signal });
        if (input.signal.aborted || run.cancelled) return;
        yield { ok: true, value: fixtureEvent({ runId: input.runId, sequence: index + 1, payload: payloads[index], last: index === payloads.length - 1 }) };
      }
    },
    async cancel(input) {
      const parsed = parseBoundary({ schema: cancelRunSchema, input: { protocolVersion: 1, ...input } });
      if (!parsed.ok) return parsed;
      const run = runs.get(input.runId);
      if (!run) return unavailable();
      run.cancelled = true;
      return { ok: true, value: { runId: input.runId, status: "cancelled" } };
    },
    async approve(input) {
      const parsed = parseBoundary({ schema: approvalResponseSchema, input: input.response });
      if (!parsed.ok) return parsed;
      const card = snapshot.cards.find(card => card.cardId === parsed.value.cardId);
      if (!card || !matchesCard({ card, response: parsed.value, now: required.runtime.clock.now({}) })) return { ok: false, error: { code: "forbidden", message: "Sample card no longer permits this response", retryable: false } };
      const previous = decisions.get(card.cardId);
      if (previous !== undefined && previous !== parsed.value.choice) return { ok: false, error: { code: "conflict", message: "Sample card already has a different choice", retryable: false } };
      decisions.set(card.cardId, parsed.value.choice);
      return { ok: true, value: { status: "recorded" } };
    },
    async acknowledgeNavigation(input) {
      const parsed = parseBoundary({ schema: navigationResultSchema, input: input.result });
      if (!parsed.ok) return parsed;
      if (acknowledgements.length === 100) acknowledgements.shift();
      acknowledgements.push(parsed.value);
      return { ok: true, value: { status: "recorded" } };
    },
  };
}

/** Fixture-side acknowledgement checks identity, digest, expiry and the offered choices. */
function matchesCard(required: { card: ConfirmationCard; response: ApprovalResponse; now: number }): boolean {
  return required.card.operationId === required.response.operationId && required.card.argumentsDigest === required.response.argumentsDigest && required.card.expiresAt > required.now && required.card.allowedChoices.includes(required.response.choice);
}

/** Concrete per-instance fixture with disabled installs and secret-free account summaries.
 * @example createSampleStudioApi({ runtime }).addons
 * @complexity <=100 packages/connections; no network, filesystem, or retained tokens.
 */
function sampleAddons(required: { runtime: StudioRuntime }): NonNullable<StudioApiPort['addons']> {
  const packages: AddonSummary[] = sampleIntegrationPlugins.map(row => ({ ...row }));
  const connections = new Map<string, IntegrationSummary>();
  const clients = new Map<string, string>();
  const secrets = new Map<string, boolean>();
  let mailSelected: string | null = null;
  let mailAlertFrom: string | null = null;
  const invalid = (): Outcome<never> => ({ ok: false, error: { code: 'invalid_input', message: 'Invalid sample add-on request', retryable: false } });
  return {
    async conversionSettings(input) {
      const parsed = setConversionSettingsSchema.pick({ pluginId: true }).safeParse({ pluginId: input.pluginId });
      return parsed.success ? { ok: true, value: { pluginId: parsed.data.pluginId, declaration: null, values: null } } : invalid();
    },
    async setConversionSettings() { return { ok: false, error: { code: 'unavailable', message: 'Conversion settings are unavailable in sample mode', retryable: false } }; },
    async mailProviderSettings() { return { ok: true, value: { selected: mailSelected, alertFrom: mailAlertFrom, candidates: structuredClone(sampleMailCandidates) } }; },
    async setMailProviderSettings(input) {
      const parsed = mailProviderSelectionSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      if (parsed.data.selected !== null && !sampleMailCandidates.some(row => row.pluginId === parsed.data.selected)) return invalid();
      mailSelected = parsed.data.selected;
      if (parsed.data.alertFrom !== undefined) mailAlertFrom = parsed.data.alertFrom;
      return { ok: true, value: parsed.data };
    },
    async setOAuthClient(input) {
      const parsed = oauthClientSetSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      if (parsed.data.client) clients.set(parsed.data.pluginId, parsed.data.client.clientId);
      else clients.delete(parsed.data.pluginId);
      return { ok: true, value: parsed.data.client ? { configured: true, clientId: parsed.data.client.clientId } : { configured: false } };
    },
    async oauthStatus(input) {
      if (!oauthStatusQuerySchema.safeParse(input.query).success) return invalid();
      if (!('pluginId' in input.query)) return { ok: true, value: { status: 'expired' } };
      const { pluginId } = input.query;
      const clientId = clients.get(pluginId);
      const status = clientId ? { configured: true, clientId } : { configured: false };
      const credentialCards = structuredClone(sampleCredentialCards.filter(card => card.pluginId === pluginId));
      return { ok: true, value: credentialCards.length ? { ...status, credentialCards, connections: [], connectionsCursor: null } : { configured: false } };
    },
    async setPluginSecret(input) {
      const parsed = pluginSecretSetSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      secrets.set(parsed.data.pluginId, parsed.data.values !== null);
      return { ok: true, value: { configured: secrets.get(parsed.data.pluginId)! } };
    },
    async pluginSecretStatus(input) { if (!pluginSecretQuerySchema.safeParse({ pluginId: input.pluginId }).success) return invalid(); return { ok: true, value: { configured: secrets.get(input.pluginId) ?? false } }; },
    async list(input) {
      const parsed = addonListRequestSchema.safeParse(input.query);
      if (!parsed.success) return invalid();
      return samplePage({ items: packages.filter(row => !parsed.data.kind || row.kind === parsed.data.kind), query: parsed.data });
    },
    async install(input) {
      const parsed = installAddonSchema.safeParse(input.request);
      if (!parsed.success || packages.length >= 100) return invalid();
      const kind = sampleKind({ request: parsed.data });
      if (!kind) return invalid();
      const id = required.runtime.ids.next({});
      const row = addonSummarySchema.parse({ id, kind, name: 'Uploaded sample ' + kind, description: 'Preview fixture; no code executed', version: '1', revision: id, enabled: false });
      packages.push(row);
      return { ok: true, value: { ...row } };
    },
    async setEnabled(input) {
      const parsed = setAddonEnabledSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      const index = packages.findIndex(row => row.id === parsed.data.id && row.kind === parsed.data.kind);
      if (index < 0) return unavailable();
      packages[index] = { ...packages[index], enabled: parsed.data.enabled };
      return { ok: true, value: { ...packages[index] } };
    },
    async uninstall(input) {
      const parsed = uninstallAddonSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      const index = packages.findIndex(row => row.id === parsed.data.id && row.kind === parsed.data.kind);
      if (index < 0) return unavailable();
      packages.splice(index, 1);
      return { ok: true, value: { ...parsed.data, removed: true } };
    },
    async integrations(input) {
      const query = pageQuerySchema.safeParse(input.query);
      if (!query.success) return invalid();
      return samplePage({ items: [...connections.values()], query: query.data });
    },
    async connect(input) {
      const parsed = connectIntegrationTokenSchema.safeParse(input.request);
      if (!parsed.success || connections.size >= 100) return invalid();
      if (connections.has(parsed.data.connectionId)) return { ok: false, error: { code: 'conflict', message: 'Use a new connection ID', retryable: false } };
      const row: IntegrationSummary = { connectionId: parsed.data.connectionId, pluginId: parsed.data.pluginId, status: 'saved' };
      connections.set(row.connectionId, row);
      return { ok: true, value: { ...row } };
    },
    async disconnect(input) {
      const parsed = disconnectIntegrationSchema.safeParse(input.request);
      if (!parsed.success) return invalid();
      const row = connections.get(parsed.data.connectionId);
      if (!row) return unavailable();
      const disconnected: IntegrationSummary = { ...row, status: 'disconnected' };
      connections.set(row.connectionId, disconnected);
      return { ok: true, value: { ...disconnected } };
    },
  };
}
/** Fixture pagination uses the same opaque index cursor on HTTP and memory; <=100 rows. */
function samplePage<T>(required: { items: T[]; query: { limit: number; cursor?: string } }): Outcome<{ items: T[]; cursor: string | null }> {
  const offset = required.query.cursor === undefined ? 0 : Number(required.query.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) return unavailable();
  const end = offset + required.query.limit;
  return { ok: true, value: { items: required.items.slice(offset, end).map(row => ({ ...row })), cursor: end < required.items.length ? String(end) : null } };
}
/** Sample upload detection is presentation-only; production delegates validation to Jini. */
function sampleKind(required: { request: import('@open-marketing/contracts').InstallAddon }) {
  if (required.request.kind) return required.request.kind;
  if (required.request.upload.kind !== 'files') return null;
  const names = required.request.upload.files.map(file => file.path.split('/').at(-1));
  if (names.includes('jini.plugin.json')) return 'plugin' as const;
  if (names.includes('plugin.json')) return 'agent-plugin' as const;
  return names.includes('SKILL.md') ? 'skill' as const : null;
}
