# Trim review: 2026-10-29-w22-sms-composer
VERDICT: APPROVED WITH CUTS

I checked the plan against the current code; there is no coordinator-note.md.
- `om_message_send` is at `agent-plugin-backends.ts:137-150`; its card is exact Allow/Cancel because the tool is `ownerOnly`.
- `messageExecution` (`:181-190`) already loads the module and reads `messageChannel`.
- `integrationSummarySchema` has no accountId (`packages/contracts/src/addons/index.ts:102`).
- `idSchema` is any string up to 256 characters (`contracts/src/values/index.ts:3`), so URL escaping is a real concern.
- Studio types tool outputs with local Zod schemas (`apps/studio/src/pages/tracking/model/tracking.hooks.ts:11-12`).
- `bindBootPluginBackends` (`index.ts:641`) sits outside `bootServer` (`:264`).

CUTS:
1. The contracts NEEDS (`messagingConnectionListSchema`, `messagePreviewInputSchema`/`OutputSchema` in packages/contracts). Define the input/output Zod schemas next to the tools in `agent-plugin-backends.ts`, as `tracking.ts:16-18` does. Studio parses the outputs with local schemas in its hooks file, as tracking.hooks does.
2. Pagination on the connections tool (`limit`, `cursor`). Return at most 100 items with no cursor; messaging connections are few. Also drop `unavailableReason` per item: list only connections whose enabled plugin passes `messageExecution` (it has a valid `messageChannel`).
3. The ingress URL-decoding NEEDS. Emit `inboundWebhookUrl` only when all three IDs match `/^[A-Za-z0-9._~-]+$/`, which needs no escaping and round-trips through today's raw-pathname route. Otherwise return `null` and Studio shows "set up manually". Do not change ingress.
4. Debounced preview with injected timers and stale-response discard (plan §4.6). Preview runs on textarea blur and once more right before send (button), with no timers. Keep one `busy` flag that disables the fieldset, as TrackingPage does.
5. `report.md` as a lane file (progress.md only). Also the "NEEDS — setup" note: it is a fact, not work.
6. "Plugin owner NEEDS" for the segment export. This build makes the two-line plugin edit itself under the w20-twilio lock (FIX 2). Only the dist rebuild stays a Coordinator NEEDS.

FIXES:
1. ONE new read tool `om_message_connections({})` in `agent-plugin-backends.ts`, beside `messageSendDefinition`, with `policy: 'read'`, `ownerOnly` like the send tool, and no effects. It returns `{ items: { pluginId, connectionId, accountId, channel, inboundWebhookUrl: string | null }[] }` (max 100).
   - Connections come from the existing integrations list. Account IDs come from the scoped account-binding LIST via `readBoundedPages` (`apps/server/src/addon-tools.ts:146`), with no direct table reads.
   - The channel comes from `messageExecution`.
   - The URL is `publicOrigin + '/hooks/agent-plugins/' + pluginId + '/' + connectionId + '/' + accountId`, under CUT 3. It is `null` without `publicOrigin`.
   - Pass `publicOrigin` into `bindAgentPluginBackends` through `bindBootPluginBackends` (`index.ts:641`) as one property. That is zero `bootServer` increments, because the value is passed at the call site.
   - Because the tool is in the om-tools catalog, the HTTP, MCP and CLI routes all reach it (assistant parity).
2. Segment preview `om_message_preview({ pluginId, connectionId, accountId, content })` → `{ segments: number | null }`.
   - It loads the module via `messageExecution` and calls its optional `countMessageSegments({ content })` export, validated as `Outcome<number>`. A missing export returns `segments: null`, which keeps it channel-neutral: WhatsApp (w22-whatsapp-sends) and any plugin without segments show no count.
   - No credential access and no fetch.
   - Twilio plugin: export the existing `countSegments` (`twilio-sms/.../src/broadcast.ts:~88`) as `countMessageSegments` from `src/index.ts`. Rename or re-export only, with no algorithm change; `priceQuote` keeps calling the same function.
3. Composer (`MessageComposer.tsx` + `message-composer.hooks.ts` in `pages/addons`):
   - Phone → `om_contacts_resolve` → select the contact, or show "No OM contact" (never create one).
   - Connection select comes from `om_message_connections`, labelled by `channel` + `pluginId`.
   - Text, then the segment count from the preview, shown only when it is not null.
   - Explicit `purpose`, `intent` (default `marketing`) and `maxCost` in integer cents (existing `messageSendSchema`).
   - One `om_message_send` call with one generated `operationId`, then the existing approve feature's `ApprovalCard` + `operation` status. Never resend automatically.
   - It shows the read-only/unavailable reason from the send tool's `unavailableReason` as-is.
4. Integrations card: `integrations.hooks.ts` loads `om_message_connections` once and joins it on `connectionId`. `IntegrationsPage.tsx` shows the URL with a Copy button using `copyToClipboard` from `@jini-ai/ui` (already a studio dep, `apps/studio/package.json:30`), or "Webhook URL unavailable: set OM_PUBLIC_ORIGIN / bind the account" when it is `null`.
5. Tests (written, not run):
   - server (`message-composer.test.ts`, new): a fixture messaging plugin with no vendor name gives one item with the URL; no `publicOrigin` gives `null`; an unsafe ID gives `null`; a foreign-scope binding is excluded; a non-messaging plugin is excluded; preview returns a number, `null` when the export is missing, and refuses malformed output;
   - twilio test: `countMessageSegments` equals the quote's segment count for one GSM and one emoji case;
   - studio (`message-composer.test.tsx`, new): contact-not-found; a single send call with the exact text/maxCost; the card renders; Copy writes the URL.

REUSE:
- Send, card and status: `messageSendDefinition` (`agent-plugin-backends.ts:137`), `apps/studio/src/features/approve/index.ts`.
- Plugin/channel discovery: `messageExecution` (`agent-plugin-backends.ts:181`).
- Pagination: `readBoundedPages` (`addon-tools.ts:146`).
- Contact lookup: `om_contacts_resolve` (`om-tools.ts:~881`).
- Segment algorithm: the Twilio `countSegments` (`broadcast.ts:~88-101`).
- Copy: `@jini-ai/ui@0.6.15-rc.2` `copyToClipboard`.
- Studio tool-call pattern: `tracking.hooks.ts` `trackingCall`.

DUPLICATES:
- None to cut. The plan searched Tovu `mail-status/feedback-setup.ts` (app-specific copy UI) and Jini payment `webhookUrlFor` (incompatible payment contract); I accept that. Jini rc.2 has no SMS segmenter or webhook-URL helper for agent plugins. No JINI ASK.

OWNER DECISIONS (defaults):
1. Contact picker = exact phone lookup, with no browsable directory. Default: accept.
2. The composer lives on the Integrations page (next to the messaging connections). Default: accept, with no new route.
3. The webhook URL is shown only for URL-safe IDs (CUT 3). Default: accept.

NEEDS:
- COORDINATOR: rebuild the twilio-sms dist (and any fingerprint/digest rows) after FIX 2. Until then, preview returns `segments: null` for Twilio.
- Lock ordering: w22-whatsapp-sends and w22-meta-postal-resolution also edit `agent-plugin-backends.ts` (w15-backends); they serialize. `index.ts` is w13 (w21-p1-5-results is building now).

APPROVED SCOPE for B1 (priority order; update progress.md after each item):
1. `om_message_connections` + `publicOrigin` wiring + server tests (FIX 1).
2. The Studio composer using the send tool + the existing card (FIX 3).
3. `om_message_preview` + the Twilio export + tests (FIX 2).
4. Integrations-card URL + Copy (FIX 4) + studio tests.
5. One typecheck each for server, studio and twilio-sms (one re-run allowed). No tests, builds or om:check.

LOCKS-FILES: apps/server/src/composition/index.ts, apps/server/src/composition/agent-plugin-backends.ts, apps/server/tests/message-composer.test.ts, apps/studio/src/pages/addons/ui/MessageComposer.tsx, apps/studio/src/pages/addons/model/message-composer.hooks.ts, apps/studio/src/pages/addons/ui/IntegrationsPage.tsx, apps/studio/src/pages/addons/model/integrations.hooks.ts, apps/studio/tests/message-composer.test.tsx, content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/broadcast.ts, content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/index.ts, content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/tests/broadcast.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-sms-composer/progress.md (lock groups: w13-server-composition, w15-backends, w20-twilio, w22-studio-pages)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted.
