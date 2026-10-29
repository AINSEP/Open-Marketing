# Progress: 2026-10-29-w22-consent-banner (builder A)

Package verified: node_modules/.pnpm/@jini-ai+cookie-consent@0.6.15-rc.2 (exports ./render ./server ./node ./client.min.js present; apps/server dep declared). Reused renderBanner / handleReceipt / readConsent / createConsentFileRecords / createNodeConsentFiles / dist/client.min.js; no OM banner, CMP state or withdrawal mechanism built.

1. DONE public.ts: shared `OM_CONSENT_POLICY` ('2026-10-29') + `omConsentBanner({mode},{nonce})` (one render config, used by tracking.ts and formGet); `POST /consent` -> handleReceipt (Request URL from publicOrigin or local host; ports store/ids injected via `PublicInput.consent`, policy constant, now = clock); `GET /consent/client.min.js` (package dist resolved via createRequire(import.meta.url).resolve — import.meta.resolve is not available under vitest — read once, cached); `/c` gate = readConsent(cookie, OM_CONSENT_POLICY, 'auto', sec-gpc/dnt, clock) -> 403 when allowed.marketing !== true (no visit/cookie/touch; body `consent: true` still parsed); `DELETE /c` -> 204 + `om_visit_<port>=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` (+Secure). Fixed routes moved to one Map (no complexity growth).
   http.ts: DELETE admitted only for exact `/c` (allowedMethod helper); publicRoute adds `/c` DELETE, `/consent` POST, `/consent/client.min.js` GET. ports.ts HttpRequest.method gains "DELETE" (needed for the route; not in LOCKS list).
   composition/index.ts: `|| path.startsWith('/consent')` in the existing public chain (no new branch); `publicServices.consent = { store: createConsentFileRecords(<stateRoot>/consent-receipts, createNodeConsentFiles({ atomicWrite: writeJsonFileAtomicAsync from @jini-ai/platform/fs })), ids }`.
2. DONE snippet.ts: one live Jini adapter `{ id: 'om-web-events', kind: 'consent-adapter', category: 'marketing' }` on window.jiniConsentQueue; grant resolves the existing consent promise; revoke() aborts (signal checked once before POST and before each tag), sends DELETE <collectionPath> same-origin, returns false once a tag ran. `window.omGrantConsent()` = `window.jiniConsent.set({ action: 'accept' })` bridge; `window.omConsent` pre-grant path removed. JSDoc documents jiniConsent.open() / `.jini-consent-reopen` footer link as withdrawal. web-events dist rebuilt.
3. DONE hosted form: formGet injects banner head/body (jini mode, durable evidence, per-response nonce from consent.ids) and CSP `style-src 'nonce-…'`; formPost attaches cookie/om_vt visit only when readConsent allows marketing, else lead stays unattributed (enquiry accepted).
4. DONE tracking.ts: input `consentBanner?: boolean` (default jini; false = headless), output `consentBanner: { head, body }` from omConsentBanner. Studio hooks + TrackingPage: banner checkbox (default on), head/body markup textareas, own-CMP bridge / footer reopen withdrawal text, proxy paths incl. /consent and /consent/client.min.js.
5. DONE tests: ingress-worker (gate: no choice / pending grant / reject / GPC / DNT -> 403 and zero rows, then one touch with a stored grant; POST /consent stores receipt + 409 on stale policy; client served; DELETE /c clears cookie and writes nothing; DELETE elsewhere refused; hosted GET nonce CSP + banner markup; form POST without grant accepted unattributed; existing /c and attribution tests now send a jini_choices grant). snippet.test.ts (adapter registered, no fetch before grant, aborted grant returns null, revoke DELETE + false after tags / true without tags, signal stops POST/tags, omGrantConsent bridge). p1-tracking (both banner modes). studio tracking.test (field reaches transport, true and false).
   Also edited apps/server/tests/om-tools.test.ts (2 mocks gain consentBanner, required by the new strict output schema).

DEFERRED: contact-level (subject) withdrawal evidence (COORDINATOR OVERRIDE / OWNER DECISION 4); form-submission receipt metadata (forms contract).

## TYPECHECK
- `pnpm --filter @open-marketing/web-events typecheck` -> pass
- `pnpm --filter @open-marketing/server typecheck` -> pass
- `pnpm --filter @open-marketing/studio typecheck` -> pass

## TESTS
- web-events `vitest run tests/snippet.test.ts` -> 35/35 pass
- studio `vitest run tests/tracking.test.ts` -> 2/2 pass
- server `vitest run tests/p1-tracking.test.ts` -> 23/23 pass
- server `vitest run tests/ingress-worker.test.ts tests/om-tools.test.ts` -> 8 failures, ALL also failing on the untouched baseline copy (scratchpad r1head): 'bare OM campaign ID' (campaign IDs are operationId-deterministic, so the "foreign" campaign has the same id), boot-root / sandbox-agent tests ("Sandbox agent did not become ready"), 'holds form withdrawal' ("Contacts storage unavailable"), 4 om-tools (incl. CLI tracking test returning no value). All new consent tests pass.

NET LINES: +330 −81
