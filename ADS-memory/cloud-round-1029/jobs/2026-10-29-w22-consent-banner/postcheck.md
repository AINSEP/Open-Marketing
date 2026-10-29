### 2026-10-29-w22-consent-banner: verdict SMALL FIXES (one MAJOR consent-first defect: regionMode 'auto')

Reviewer R2, 2026-10-29. I checked `git show 24e3381` against the installed `@jini-ai/cookie-consent@0.6.15-rc.2` dist and re-ran the tests, typechecks and eslint.

This commit holds two jobs. I separated them by LOCKS-FILES:
- **Consent-banner hunks:** public.ts (everything except `landingSchema.omit` and `userAgentProperty`), http.ts, index.ts, tracking.ts, snippet.ts, the Studio tracking files, p1-tracking, the consent tests in ingress-worker, and snippet.test.
- **Contacts-meta hunks:** the `client_user_agent` lines in public.ts, identity.ts, web-events types and rules, and measure.

#### Ledger

1. public.ts: FIXED, with one defect.
   - The `OM_CONSENT_POLICY` constant and the `omConsentBanner` helper exist, and both tracking.ts and formGet use them.
   - `POST /consent` calls `handleReceipt`. The Request URL is built from the public origin, or the local host when there is no public origin.
   - `GET /consent/client.min.js` serves the package dist, read once.
   - The `/c` gate calls `readConsent`, with GPC/DNT and the durable rule, and runs before `visit()` (public.ts:217).
   - `DELETE /c` returns 204 and clears the cookie. It writes nothing else.
   - The defect: `regionMode` is `'auto'` (see New #1).
2. http.ts / index.ts routing and `publicServices.consent`: FIXED.
   - DELETE is admitted only for the exact `/c` path (http.ts:46-49).
   - `/consent` joins the existing `||` chain, so `handleBootRequest` gains no complexity increment.
   - In `bootServer`, the consent store is one object property built through the `consentReceiptStore` helper, so there are zero new branches.
3. snippet.ts: FIXED.
   - There is exactly one adapter: `om-web-events`, category marketing.
   - `grant` resolves the existing promise.
   - `revoke()` is real: it aborts, sends `DELETE /c` same-origin, and returns `!tagRan`.
   - The abort signal is checked before the POST and before each tag.
   - `omGrantConsent` is a bridge to `jiniConsent.set({ action: 'accept' })`; I verified `set` in the client dist (client/index.js:113).
   - The `window.omConsent` pre-grant path is removed, and the JSDoc documents withdrawal.
4. Hosted form: FIXED.
   - formGet renders the banner with a per-response nonce taken from the injected ids (`randomUUID` in serve.ts:134), and adds `style-src 'nonce-…'` to the CSP.
   - The banner's inline JSON config is a non-executing `<script type="application/json">`, and the client loads under `script-src 'self'`.
   - In formPost, `verifyOptionalVisit` attaches a visit only when `consented` is true. Without consent the enquiry is accepted but unattributed (test at ingress-worker:365).
5. tracking.ts + Studio: FIXED.
   - Input is `consentBanner?: boolean` (default jini; false gives headless), and the output carries `{ head, body }`.
   - Studio adds a checkbox and two read-only textareas, explains the own-CMP bridge and the footer reopen link, and lists the proxy paths.
6. Tests (FIX 8): FIXED.
   - Covered: no choice, pending, reject, GPC and DNT all give 403 with zero rows; a stored grant gives one touch; receipt 201 and stale-policy 409; client served; DELETE clears the cookie; DELETE is refused elsewhere; nonce CSP; form without a grant stays unattributed; snippet adapter, revoke and signal; both banner modes; the Studio field.
   - Missing: a case for the region hint (New #1).
7. COORDINATOR OVERRIDE: FIXED.
   - The package is installed.
   - The rc.2 reject behaviour is accepted.
   - Subject-level withdrawal is DEFERRED.

#### Outside lane

- `apps/server/src/ports.ts`: `HttpRequest.method` gains `"DELETE"`. This is needed for the route, and transport admits DELETE only for `/c`. Accepted.
- `apps/server/tests/om-tools.test.ts:96,931`: two mocks gain `consentBanner`, which the strict output schema requires. Accepted.

#### New

1. **[MAJOR] public.ts:29, :37, :91: `regionMode: 'auto'` breaks consent-first.**
   - Verified in the dist:
     - policy.js `regionFrom`: when the mode is `'auto'` and the `jini_region` cookie hint is `'us'`, the region becomes `'opt-out'`.
     - policy.js `effective`: with no stored choice, the choices become `flags(region === 'opt-out')`, which means all true.
     - `permissionFor` only withholds a grant when a live grant exists but is unconfirmed (`live && durable && !live.r`), so with no live choice it grants nothing extra but also blocks nothing.
     - So `readConsent` returns `allowed.marketing === true` for a request carrying only `Cookie: jini_region=us`.
     - The browser client does the same: client/index.js:24 reads the same cookie, so the adapter's `grant()` fires with no click.
   - Failure:
     - A visitor, a site script, or any third party able to set a first-party cookie sets `jini_region=us`.
     - The snippet POSTs `/c`, the server gate passes, and OM writes `web_visit`, `web_event` and `web_touch` (click IDs, plus UA/URL from the contacts-meta job) and sets `om_visit_*`, all with no consent choice.
     - The same applies to formPost attribution.
   - Ruling on the builder's follow-up: this **violates** the owner rule "OM stores nothing about a visitor before visitor consent" (opt-in everywhere). An opt-out region model is an owner/legal decision that was never taken, and OM has no trusted region resolver. jini region.js itself says a browser hint must not relax anything.
   - Fix: `'opt-in'` in all three places (Small fixes 1-3), plus a regression test (Small fix 4).
2. **[MINOR] public.ts:91: `POST /consent` has no rate limit.**
   - `handleReceipt` accepts `ReceiptOptions.allow`, but none is bound.
   - Failure: a public client can POST valid 2 KB receipts in a loop. Each one writes an immutable file under `<stateRoot>/consent-receipts`, so the disk grows without bound.
   - FOLLOW-UP: bind `allow` to a host limiter (`consentRateLimitKey` plus the existing rate-limit facility).
3. **[MINOR] public.ts:92: the receipt response drops Jini's `cache-control: no-store`.**
   - Only the status, content type and body are copied.
   - Failure: an intermediary proxy may cache the 201 `{ id }`.
   - Fix: Small fix 5.
4. **[MINOR] snippet.ts revoke: no re-grant without a reload.**
   - When no tag ran, `revoke()` returns true, so Jini does not reload. `stop` stays aborted, and a later re-accept on the same page returns null from `grant()`.
   - Effect: no collection until the next page load. This errs on the safe side. No fix.
5. **[MINOR, deferred] Jini withdrawal is not recorded at subject level.**
   - Withdrawal stops collection (cookie gate plus DELETE), but touches that are already bound are not withdrawn.
   - Consequence: they keep feeding attribution and, through contacts-meta, UA/URL enrichment. This is DEFERRED by override (OWNER DECISION 4) and must stay on the follow-up list.
6. **Checked and clean:**
   - The server never trusts the browser level: the body's `consent: true` authorises nothing, and only the `jini_choices` cookie plus `readConsent` decide.
   - GPC/DNT are clamped in the package and forwarded to `handleReceipt`.
   - No secrets are echoed; Jini's problem strings are fixed text.
   - The `consentClient` module cache holds an inert public asset, not a capability.
   - No vendor names appear in core.
   - eslint passes (complexity ≤10, nesting ≤3).
   - `bootServer` has no new branch.

#### Disputes and deferrals

- Subject-level withdrawal evidence: DEFERRED-OK (override).
- Form-submission receipt metadata: DEFERRED-OK, because it needs a forms contract change.
- The builder attributes 3 `ingress-worker` failures to the baseline. I accept that: the bare/foreign campaign ID test fails because the campaign ID is operationId-deterministic, plus the sandbox-agent boot test and the "holds form withdrawal" contacts test. None of them touch the consent paths. The builder verified this on a clean baseline copy.

#### Typecheck

R2 re-runs, all pass:
- `apps/server` typecheck (src + tests)
- `features/web-events` typecheck
- `features/measure` typecheck
- eslint on all changed sources

Tests:
- `ingress-worker` + `p1-tracking`: 62/65 (the 3 baseline failures above)
- `web-events`: 111/111
- `studio tracking`: 2/2

#### Small fixes

1. apps/server/src/inbound/public.ts:29
   - old: `client: { contract: 1, policy: OM_CONSENT_POLICY, regionMode: 'auto' }`
   - new: `client: { contract: 1, policy: OM_CONSENT_POLICY, regionMode: 'opt-in' }`
2. apps/server/src/inbound/public.ts:37
   - old: `return readConsent({ cookieHeader: headers.cookie, policy: OM_CONSENT_POLICY, regionMode: 'auto' },`
   - new: `return readConsent({ cookieHeader: headers.cookie, policy: OM_CONSENT_POLICY, regionMode: 'opt-in' },`
3. apps/server/src/inbound/public.ts:91
   - old: `}, { regionMode: 'auto' });`
   - new: `}, { regionMode: 'opt-in' });`
   - Also update the JSDoc at :25-27: append "Always opt-in: OM never relaxes on a region hint (consent-first)."
4. apps/server/tests/ingress-worker.test.ts:
   - After line 324 (`{ name: 'pending grant', choice: 'pending', signal: {} },`), insert: `    { name: 'US region hint without a choice', choice: 'usHint', signal: {} },`
   - At line 331, change `const cookies = { none: '', pending:` to `const cookies = { none: '', usHint: 'jini_region=us', pending:`
   - That case must give 403, no set-cookie, and 0 rows in all three tables. It fails today, which proves the defect.
5. apps/server/src/inbound/public.ts:92
   - old: `body: await result.text() };`
   - new: `body: await result.text(), headers: { 'cache-control': 'no-store' } };`

After the fixes, re-run `apps/server` `vitest run tests/ingress-worker.test.ts tests/p1-tracking.test.ts` and `pnpm run typecheck`. The `p1-tracking` assertions check `"banner":"…"` and the policy, not the region, so they stay green.

FOLLOW-UP:
- Bind a receipt rate limit (New #2).
- Record subject-level withdrawal (New #5, OWNER DECISION 4).
- JINI ASK: a memory-only reject mode, and `readConsent` exposing the receipt id.
