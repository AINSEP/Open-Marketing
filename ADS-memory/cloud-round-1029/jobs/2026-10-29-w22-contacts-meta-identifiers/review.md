# Trim review: 2026-10-29-w22-contacts-meta-identifiers
VERDICT: APPROVED WITH CUTS

I checked the plan against the current code; there is no coordinator-note.md.
- `identifierKeys` exists only in the measure memory test double (`features/measure/src/memory.ts:14-34`). It has no production writer, and the production policy consent is scoped by destination and purpose.
- `ingestConversion` has no server caller yet (rg), so no event is committed in production today.
- `dispatcher.ts:58-59` requires exact key-set equality through `eventIdentity` (`rules.ts:54-58`), so the bug is real.
- Plugins read UA/URL from `event.identifiers` (meta `capi.ts:77`, tiktok `events.ts:19,92`).
- `parseResolvedDeliveryInput` (`delivery/input.ts:26`) requires the identifier keys to equal the digest keys.

CUTS:
1. The whole durable identifier-coverage design: plan §4.1/§4.5 and NEEDS 1-3. That means policy `Consent.identifierKeys`, forms `ConsentWording`/`ConsentCapture.identifierKeys`, the `forms.ts` edit, and the `measure/adapters/capabilities.ts` forwarding. It is not asked for: production consent is per destination and purpose, and UA/URL are captured only behind the visitor's collection consent. Mark job item (2) DISPUTED for production: no writer exists. The only fix is the memory double (FIX 5).
2. New `event_source_url` landing property and the separate URL capture. Reuse the existing `pageUrl`, which is already query- and fragment-free and Origin-checked by `heartbeatProperties` (`public.ts:131-135`). `mapTouch` copies it into the mutable map as `event_source_url`.
3. The `features/measure/src/rules.ts` edit (raising the 1024 identifier bound). Store `event_source_url` only when it is ≤1024 characters; otherwise leave it absent, and Meta reports "not sent".
4. Deriving the `MemoryConsentEvidence` type from Zod. It is not in the job: only the alias line changes.
5. `report.md` as a lane file (progress.md is enough). Also the "Coordinator rebuilds runtime artifacts" NEEDS: no plugin is touched.
6. The "uncommitted extras are omitted" dispatch rule (plan §4.7/§4.8). It would drop UA/URL and `phone_digits` for every commit that lacks them, which defeats items (1) and (3). FIX 4 replaces it.

FIXES:
1. Capture (`apps/server/src/inbound/public.ts`, `collect`/`landingProperties`). After the existing consent gate passes (do not touch the gate lines; w22-consent-banner owns them), add `client_user_agent` from `request.headers['user-agent']`, trimmed and only if 1..1024 characters, to the server-built properties.
   - The browser must NOT be able to supply it: the landing schema in `public.ts:20-22` must keep rejecting `client_user_agent` (`landingPropertiesSchema.omit(...)` or add the key only server-side).
   - Also add `'client_user_agent'` to the collection allowlist in `apps/server/src/composition/identity.ts:80`.
2. Storage (`features/web-events/src/types.ts`, `rules.ts`):
   - Add `client_user_agent: z.string().min(1).max(1024).optional()` to `landingPropertiesSchema`.
   - In `touchSchema` (`rules.ts:19`), `clickIdentifiers` gains optional `client_user_agent` and `event_source_url` (both ≤1024).
   - `mapTouch` (`:79-86`) copies `client_user_agent` and `pageUrl` → `event_source_url`. It stores them only as a PAIR (both present) and keeps the browser click-key loop unchanged.
   - `canonicalClicks` (`:107`) and the replay digest include the two keys.
   - Erasure is free: `purgeSubject` already clears the whole mutable map.
   - Fix the "Raw page URLs are never persisted" doc line (types.ts:7). It now reads: origin+path is kept in the mutable touch map and purged on erasure.
   - No migration.
3. Enrichment (`identity.ts:83`). The `identifiersFor` adapter calls `contacts.identifiersFor`. On ok, it reads `webEvents.touchesFor({ subjectId, window: last 30 days (same as forms.ts:69), limit: 10 })`, which is newest-first since w22-newest-first-touch, and takes the FIRST touch that has both keys.
   - It adds `identifiers.client_user_agent` / `identifiers.event_source_url` and their digests, using `destinationIdentifierHash` from `@open-marketing/contacts` (index.ts:5).
   - If there is no such touch, it adds nothing.
   - The contacts denial and failure paths are unchanged. Complexity ≤10: put it in one small helper.
4. Dispatcher (`features/measure/src/delivery/dispatcher.ts:52-60`). Replace the full `eventIdentity` comparison with a check that the subject matches and that every committed `identifierDigests` key exists in the evidence with an equal value. Then forward the RESOLVED `identifiers` + `identifierDigests` (the superset) in the transient input only.
   - The committed event, `eventIdentity`, `deliveryIdentity` and the ledger are unchanged.
   - Plugins already ignore unknown keys (meta `capi-normalization.ts:12` z.object, tiktok `events.ts:19`).
   - The transient event carries the resolved `identifierDigests` as well, so the key-parity check in `input.ts:26` still holds. The record identity is computed from the committed input at `dispatcher.ts:39`, before resolution.
   - Keep the refusal message for a missing or changed committed digest.
5. Memory consent double (`memory.ts:34`): an evidence list with `phone` also covers `phone_digits` (alias; contacts uses the same HMAC for both, `contacts/src/rules.ts:128`). It is one expression in the `every` callback. Withdrawal precedence is unchanged.
6. Tests (written, not run):
   - delivery: a legacy `{email, phone}` commit + resolver `{email, phone, phone_digits, client_user_agent, event_source_url}` dispatches once with all five keys; a changed committed digest still refuses; a missing committed key refuses;
   - boundaries: `phone` evidence covers a `phone_digits` commit;
   - web-events port-suite: the pair is stored and replayed; purge clears it; a lone UA is not stored;
   - ingress-worker: UA is captured only on the consented `/c` path; a browser-supplied `client_user_agent` is rejected (400); the enriched identifiers reach the adapter after form binding; erasure removes them.

REUSE:
- The URL is the existing `pageUrl` + `heartbeatProperties` (`public.ts:131-135`).
- Mutable click map + purge: web-events `mapTouch`/`purgeSubject` (`rules.ts:79`, both repos).
- Newest touch read: `touchesFor` (newest-first per w22-newest-first-touch).
- Hash: contacts `destinationIdentifierHash` (`features/contacts/index.ts:5`).
- 30-day window: `apps/server/src/composition/forms.ts:69`.

DUPLICATES:
- None found. Jini analytics deliberately drops raw UA (plan §5), Tovu has no identifier coverage, and Jini cookie-consent receipts carry no subject. Nothing to reuse or ask for.

OWNER DECISIONS (defaults):
1. Dispatch forwards the resolved superset (incl. `phone_digits`, UA/URL), provided every committed digest still matches. Default: yes. The extras come from the same per-destination/purpose contacts + suppression gate, and plugins drop keys they don't map. The plan's "committed keys only" would leave Meta without `ph`/UA/URL for every existing commit.
2. UA/URL come from the newest consented touch in 30 days, not the touch at conversion time. Default: accept. There is no per-event context path today.
3. Consent dependency: UA/URL are captured only where `/c` is already consent-gated. When w22-consent-banner moves the gate to the stored Jini receipt (`readConsent`), this capture inherits it unchanged. Build AFTER consent-banner releases `public.ts` / `ingress-worker.test.ts` (same w14-surface lock), and edit only the capture lines.

NEEDS:
- w22-tiktok-conversion-delivery: `event_source_url` is supplied by FIX 3 (same key in `identifiers`). Nothing more is needed.
- DEFERRED: capture on a form submit without a consented touch (forms has no metadata contract; the banner + touch flow covers the hosted form).

APPROVED SCOPE for B1 (priority order; update progress.md after each item):
1. Dispatcher superset rule + memory alias + measure tests (FIXES 4, 5).
2. web-events storage of the UA/URL pair + port-suite/fixtures/adapters tests (FIX 2).
3. Capture in `public.ts` + collection allowlist and enrichment in `identity.ts` + ingress-worker tests (FIXES 1, 3).
4. One typecheck each for measure, web-events and server (one re-run allowed). No tests, builds or om:check.

LOCKS-FILES: apps/server/src/composition/identity.ts, apps/server/src/inbound/public.ts, apps/server/tests/ingress-worker.test.ts, features/web-events/src/types.ts, features/web-events/src/rules.ts, features/web-events/tests/fixtures.ts, features/web-events/tests/port-suite.ts, features/web-events/tests/adapters.test.ts, features/measure/src/delivery/dispatcher.ts, features/measure/src/memory.ts, features/measure/tests/delivery.test.ts, features/measure/tests/boundaries.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-contacts-meta-identifiers/progress.md (lock groups: w13-server-composition, w14-surface, w16-web-events, w20-measure)
