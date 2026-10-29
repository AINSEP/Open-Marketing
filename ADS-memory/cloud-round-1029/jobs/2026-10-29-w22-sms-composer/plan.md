Software Architect(Direct):

1. **Summary**

Add a small message composer to the existing Integrations page. The owner finds and selects an existing OM contact by phone, chooses a messaging connection, enters text, sees its segment count, and opens the existing exact Allow/Cancel card. Connection cards also show the server-computed inbound webhook URL with Copy; the assistant and CLI retrieve the same URL through an OM read tool. One build run is planned, after the coordinator prerequisites below land.

2. **Files**

- `apps/server/src/composition/agent-plugin-backends.ts` — (edit) add messaging connection and segment-preview read tools beside `om_message_send`.
- `apps/server/tests/message-composer.test.ts` — (new) fixture tests for discovery, preview, URL construction, scope and unavailable states.
- `apps/studio/src/pages/addons/ui/MessageComposer.tsx` — (new) composer markup and existing `ApprovalCard` composition.
- `apps/studio/src/pages/addons/model/message-composer.hooks.ts` — (new) contact lookup, preview, frozen submission and operation status.
- `apps/studio/src/pages/addons/ui/IntegrationsPage.tsx` — (edit) mount composer; display connection URLs and Copy controls.
- `apps/studio/src/pages/addons/model/integrations.hooks.ts` — (edit) load messaging connections once and bind URL/copy state.
- `apps/studio/tests/message-composer.test.tsx` — (new) composer, approval and callback-copy regressions using existing HTTP/runtime fixtures.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-sms-composer/progress.md` — (new) implementation progress.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-sms-composer/report.md` — (new) changes, written tests, verification, NEEDS and actual line delta.

No other worker-owned files.

3. **Public contracts**

New read tools, available through existing HTTP/MCP/CLI dispatch:

- `om_message_connections({ limit, cursor? })` → `{ items, cursor }`.
- Each item: `{ pluginId, connectionId, accountId, channel: string | null, inboundWebhookUrl: string | null, unavailableReason: string | null }`.
- `om_message_preview({ pluginId, connectionId, accountId, message: { content } })` → `{ segments: number }`.

Reuse unchanged:

- `om_contacts_resolve({ identifier: { kind: 'phone', raw } })`.
- `om_message_send({ operationId, pluginId, connectionId, accountId, recipient, purpose, intent, message, maxCost })`.
- `StudioApiPort.tool`, `approvalCard`, `approve` and `operation`.

Shared wire types derive from coordinator-owned Zod schemas. No new send endpoint, API port, registry or factory.

4. **Approach**

1. **MAJOR first: discovery and composer.** Join existing scoped connection summaries with account bindings. Reuse `readBoundedPages`; never query feature tables directly or add another pagination implementation.
2. Inspect enabled plugin exports through existing revision/module-loading checks. Derive channels from `messageChannel`; inspect `sendMessage` and `ingestWebhook` support without vendor IDs. Callback-only connections remain displayable.
3. Add the preview read tool. It calls the plugin’s exposed existing segment counter, validates its result, and performs no credential access or vendor request. Missing preview support returns an explicit unavailable result.
4. Use exact phone lookup as the smallest contact picker: show the matching existing contact for selection. Never create a contact or consent evidence from this form.
5. Compose plain text only. Keep the existing required consent-purpose and maximum-cost fields explicit; default intent to marketing. Preserve the existing `moneySchema` integer minor-unit contract—no floating-point money or new money representation.
6. Preview bounded text after a short pause using injected timers; discard stale responses. Freeze the selected contact, connection, text, purpose and maximum when submitting.
7. Call `om_message_send` once with one operation ID, then load and render its existing `ApprovalCard`. The card exposes recipient, exact text and approved maximum, with Allow/Cancel only. Lock editing while pending; recover status through `operation`, never automatically resend an uncertain outcome.
8. **MINOR second: callback display.** Return URLs computed from configured public origin and scoped plugin/connection/account IDs. Integrations renders those server values and uses Jini’s copy helper. Missing origin or account binding produces setup guidance rather than an invented URL.
9. Write fixture regressions for discovery without vendor-name assumptions; disabled/foreign bindings; missing origin; malformed preview output; contact-not-found; stale previews; one send submission; exact card contents/choices; unknown outcomes; URL copying. Existing server send tests retain dispatch-time consent coverage.
10. Update progress after each scope item. End with one Studio and one server package typecheck; permit one corrective rerun each. Run no tests, builds or `om:check`.

5. **Reuse**

- **Contact selection:** `features/contacts/index.ts` and `apps/server/src/om-tools.ts:881` already expose exact resolution. No contact-list API currently exists.
- **Send/card/status:** existing `messageSendDefinition`, `dispatchMessage`, `apps/studio/src/features/approve/index.ts`, and shared API HTTP methods.
- **Discovery:** `pluginExecution`, `executableRevision`, existing module loader, `readBoundedPages`, and public `AccountBindingListPort`.
- **Segmentation:** existing `twilio-sms/.../src/broadcast.ts:89` counter and its w21 regressions. Expose and call it; do not copy its algorithm into core or Studio.
- **Copy:** installed `@jini-ai/ui@0.6.15-rc.2` exports `copyToClipboard({ text }, options?)`; verified its installed declaration and injected writer/document options.
- **Sibling search:** searched Jini/Tovu for SMS segmentation, contact pickers, message preview and webhook setup. Tovu’s `mail-status/feedback-setup.ts` and email Copy control demonstrate the interaction, but are application-specific. Jini’s payment `webhookUrlFor` has an incompatible payment-provider contract.
- No matching generic SMS implementation was found in those searches. npm registry checks were attempted but inaccessible; no new dependency is proposed.

6. **Deliberately left out**

- A browsable contact directory, templates, attachments, broadcasts, scheduling, delivery receipts and credential editing.
- Local segmentation copies, pricing requests during typing, new approval UI, new grants, retries and a second send path.
- Production-mode enablement: current boot remains read-only and the composer must show that honestly.
- **DEFERRED if the timebox is reached:** callback-card presentation, after the composer and shared read tool are complete. Record it explicitly rather than claim completion.

7. **NEEDS**

- **NEEDS — coordinator/contracts:** add `messagingConnectionListSchema`, `messagePreviewInputSchema` and `messagePreviewOutputSchema` in `packages/contracts/src/capabilities/index.ts`, with the shapes above and schema-derived types.
- **NEEDS — plugin owner:** expose the existing counter as `countMessageSegments({ content }): Outcome<number>` from the SMS plugin’s public entry; keep `priceQuote` using that same implementation. This serves the existing quote and the new preview, without a second algorithm. Coordinator owns plugin tests and dist/digest rebuild.
- **NEEDS — coordinator/composition:** forward already-validated `publicOrigin` to the backend binding in `apps/server/src/composition/index.ts`; preserve existing account-list/connection-list methods. Add zero complexity increments to `bootServer`.
- **NEEDS — coordinator/ingress:** generated URL IDs must round-trip through the webhook route. Current ingress uses encoded `URL.pathname` captures without decoding; resolve this for connection names requiring escaping and add a regression.
- **NEEDS — setup:** messaging accounts require existing workspace bindings; saving credentials alone does not create one. Do not infer account IDs by parsing vendor credentials in core.
- Installs: none. Migrations: none. Acquire the listed file locks before building; prerequisites land before the single build run.

8. **Unverified facts and risks**

Both requested UI gaps remain real: `IntegrationsPage.tsx` lacks a composer/URL display, and `integrationSummarySchema` exposes no account ID. No disputed finding was identified.

No vendor API change is planned. Segment counts reuse the plugin’s conservative calculation; they are not a new billing promise. Missing preview, binding, origin or send authority keeps sending unavailable.

A displayed callback URL does not prove vendor configuration or successful ingress. Existing plugin credential requirements, including any saved callback URL, still apply. Preserve fixed errors and existing dispatch-time consent checks.

9. **Size estimate**

Nine worker-owned files: five source, two tests, two records. Approximately **280–360 source LOC** and **180–240 test LOC**, mostly additive; report actual additions/removals afterward. Target **80–90 minutes**, excluding coordinator prerequisite work; no checks run during this planning phase.