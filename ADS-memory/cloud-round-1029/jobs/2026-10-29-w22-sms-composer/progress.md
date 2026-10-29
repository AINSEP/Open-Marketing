# W22-SMS-COMPOSER progress (builder C, 2026-10-29)

1. DONE: `om_message_connections` (FIX 1). It is a read tool with ownerOnly, no effects and no cursor, and returns at most 100 items. It joins `integrations.list` with the scoped `listAccountBindings` through `readBoundedPages`. It drops foreign-scope bindings and disconnected connections. Each candidate must pass `messageExecution`; the channel comes from `messageChannel`. The URL is `new URL(publicOrigin).origin + /hooks/agent-plugins/<plugin>/<connection>/<account>`. It is null without an origin, and null unless every ID matches `^[A-Za-z0-9._~-]+$`, excluding `.` and `..`. The plugin ID must also match the route pattern.
   - Wiring: `Dependencies.integrations.list?`, `accountList?` and `publicOrigin?` were added (all optional).
   - In `index.ts`, the `bindBootPluginBackends` call site now passes `publicOrigin: config.value.publicOrigin, accountList: catalogScope.accountBindings`. These are properties only, with zero `bootServer` complexity increments. The second property was needed because `services.accountBindings` is typed lookup-only.
   - Files: apps/server/src/composition/agent-plugin-backends.ts, apps/server/src/composition/index.ts. Tests: apps/server/tests/message-composer.test.ts.
2. DONE: Studio composer (FIX 3).
   - Exact phone lookup goes through `om_contacts_resolve`. If nothing matches it shows "No OM contact" and never creates a contact.
   - The connection select comes from `om_message_connections`.
   - Preview runs on blur and once more before send, with no timers beyond the existing 25s per-read deadline.
   - The form takes explicit purpose and intent (default marketing) and maxCost in integer USD cents.
   - There is one `om_message_send` call with one runtime operation ID, followed by the existing `ApprovalCard` and an `operation` status check. A fieldset lock stays on while the send is pending or its outcome is unknown, and there is no automatic resend. A tool failure message (`unavailableReason`) is shown as-is.
   - Files: apps/studio/src/pages/addons/ui/MessageComposer.tsx, apps/studio/src/pages/addons/model/message-composer.hooks.ts.
3. DONE: `om_message_preview` + Twilio export (FIX 2).
   - The tool calls the optional `countMessageSegments({ content })` export, validated as `Outcome<positive int>`. A missing export gives `segments: null`, malformed output is refused, and a plugin refusal gives `invalid_input`. It never accesses credentials and never fetches.
   - Twilio: `countSegments` was renamed to the exported `countMessageSegments`, with the algorithm unchanged; `priceQuote` calls the same function. It is re-exported from src/index.ts.
   - Test added to tests/broadcast.test.ts.
4. DONE: Integrations card URL + Copy (FIX 4).
   - `useIntegrations` loads `om_message_connections` once per load, alongside the integrations list, and joins on `connectionId`. The composer gets the same list, so no second read is made.
   - `ConnectionRow` shows the URL with "Copy webhook URL" (`copyToClipboard` from `@jini-ai/ui`). When the URL is null it shows "Webhook URL unavailable: set OM_PUBLIC_ORIGIN / bind the account".
   - Files: integrations.hooks.ts, IntegrationsPage.tsx.
   - Tests: apps/studio/tests/message-composer.test.ts. It is `.ts`, not `.tsx`, because the TSX component-body lint rule fires on test arrows; this follows tracking.test.ts.
   - Fixture adjustment: apps/studio/tests/addons.test.ts, 3 tool mocks. They now answer `om_message_connections` without counting it as an OAuth start.
5. DONE: typechecks and tests (see below).

## TYPECHECK
- `pnpm --filter @open-marketing/server typecheck`: PASS on the first run. On a later re-run, src (`tsc --noEmit`) passes. The tests project then failed only in tests/ingress-worker.test.ts:334 and tests/om-tools.test.ts:96,931, both tracking/consent job files edited concurrently, not by this job.
- `pnpm --filter @open-marketing/studio typecheck`: PASS.
- twilio-sms `pnpm run typecheck` (content/agent-plugins/twilio-sms; it is not a workspace filter target): PASS.
- eslint on the changed src and new tests: clean. The remaining error at agent-plugin-backends.ts:930 (`fetch` two-object-arguments) is a pre-existing line, not changed here.

## TESTS
- server `vitest run tests/message-composer.test.ts`: 5/5 pass.
- server `tests/message-send.test.ts` and `tests/messaging-webhooks.test.ts`: fail at fixture contact upsert ("Invalid identifier" from `identity.contacts.upsert` phone). This is unrelated to this job; it was probed in isolation, and the contacts/identity area belongs to the concurrent consent/contacts job.
- server `tests/agent-plugin-backends.test.ts`: campaign tests fail with "Boundary validation failed". This also appears unrelated, since the new definitions parse fine in the composer tests.
- studio `vitest run tests/message-composer.test.ts`: 4/4 pass.
- studio `tests/addons.test.ts`: the failures that remain are pre-existing ConversionGrants interference. `om_measure_grants_list` appears in the OAuth `names` list, and a duplicate `role=alert` comes from "Grant response unavailable".
- twilio-sms `pnpm run test`: 71/71 pass.

## DIST
- The twilio-sms dist was rebuilt with `pnpm run build` (esbuild). dist/index.mjs sha256 went from c44da6e3… to e1a51846…; dist/ is gitignored.
- The capabilities.json/plugin.json `schemaFingerprint` (SHA-256 of src/commands.ts) is UNCHANGED, because commands.ts was not touched. There is no other digest row.

NET LINES (this job only):
- Tracked files: +138 −19.
  - agent-plugin-backends.ts: +92 −6
  - index.ts: +4 −2 (the rest of that file's diff belongs to other jobs)
  - integrations.hooks.ts: +17 −5
  - IntegrationsPage.tsx: +8 −1
  - addons.test.ts: +3 −3
  - twilio: +18 −5
- New files: +412 (MessageComposer.tsx 34, message-composer.hooks.ts 155, server test 120, studio test 103).
- Total: +550 −19.
