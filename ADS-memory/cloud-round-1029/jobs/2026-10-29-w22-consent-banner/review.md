# Trim review: 2026-10-29-w22-consent-banner
VERDICT: APPROVED WITH CUTS (build starts only after Coordinator NEEDS 1 is done)

coordinator-note.md wins over plan.md. The plan reuses @jini-ai/cookie-consent correctly. What to cut: the visit-expiry storage work, the OM re-validation of policy/expiry/signals, and a pile of Coordinator NEEDS that the build can do itself under locks.

CUTS:
1. `findVisit` / `expireVisit` on WebEventRepoPort, plus their edits in `memory.ts`, `sql.ts` and `tests/port-suite.ts` (4 files). Withdrawal stops collection without them:
   - Jini's withdraw choice flips `jini_choices`, so the server gate (FIX 2) refuses `/c` and hosted-form attribution.
   - `DELETE /c` (FIX 4) clears the HttpOnly `om_visit_*` cookie.
   - An old token can no longer collect because every collection path is gated on the consent read.
2. OM-side "validate policy, expiry, effective category and privacy signals" in `/c` (plan §4.5). `readConsent` from `@jini-ai/cookie-consent/server` already does all of that, including GPC/DNT and "durable: an unconfirmed grant is not allowed" (source `ai-traces-jini/packages/cookie-consent/src/server/receipt.ts:104`). Use it (FIX 2) and add no OM copy.
3. A per-event receipt-store lookup plus OM parsing of Jini's cookie format to get the receipt id. That would duplicate Jini's cookie wire format, and Jini's documented gate is the cookie with "no file read per event". If proof per event is wanted later, it becomes a JINI ASK (OWNER DECISION 2).
4. `features/web-events/README.md` (new doc). Document the withdrawal call and link in the Studio tracking text and the `webEventInstallSource` JSDoc instead.
5. Plan §7 NEEDS that the build does itself under locks: the routing lines in `inbound/http.ts` and `composition/index.ts`, `composition/tracking.ts`, and the `p1-tracking` parity test. `om-tools.ts:931` already shares `trackingSnippetInputSchema`, so HTTP, tool and CLI parity comes for free. Also cut the "rebuild runtime artifacts" NEEDS: no plugin dist is involved.
6. Subject-level withdrawal binding in `composition/identity.ts` (withdrawal evidence appended so later conversion dispatch is refused). Also "delayed form acceptance preserves enquiry when the visit has expired". Both are DEFERRED: Jini receipts carry no subject, and mapping one cookie withdrawal to the subject's per-destination/purpose consents is an open owner decision (OWNER DECISION 4). With cut 1 there is no visit expiry, so forms acceptance is unchanged.
7. Passing an abort signal through every tag activation. Instead, check `signal.aborted` once before the POST and once before each tag. Tags cannot be unloaded, so `revoke()` returns false once any tag ran, and Jini reloads the page.

FIXES:
1. Consent category (snippet.ts). Register ONE OM adapter, category **marketing** (not analytics), covering the collector and the admitted tags. The OM collector stores ad click IDs (gclid/fbclid/...) that feed vendor conversion uploads, so "analytics yes, marketing no" must not record them.
   - Push it on `window.jiniConsentQueue` as `{ id, kind: 'consent-adapter', category: 'marketing', grant({ signal }) }`.
   - `grant` resolves the existing consent promise.
   - `revoke()` sets a stopped flag and sends `fetch('/c', { method: 'DELETE', mode: 'same-origin', credentials: 'same-origin' })`. It returns `true` if no tag ran and `false` otherwise.
   - `window.omGrantConsent()` stays as the own-CMP bridge: `window.jiniConsent.set({ action: 'accept' })` in headless mode. Drop the `window.omConsent === true` pre-grant path, because the server gate refuses it anyway.
2. `/c` gate (`public.ts` `collect`, currently `:162`). Before `visit()`:
   - Call `readConsent({ cookieHeader, policy: OM_CONSENT_POLICY, regionMode: 'auto' }, { secGpc: headers['sec-gpc'], dnt: headers.dnt })`.
   - If `allowed.marketing !== true`, return 403 with no visit, no cookie and no touch.
   - The body's `consent: true` is still parsed (wire unchanged) but no longer authorises anything.
3. Receipt endpoint (`public.ts`). `POST /consent` calls `handleReceipt` with:
   - a `Request` built from `publicOrigin` + path, so Jini's origin check is meaningful;
   - `ports { store, policy: () => OM_CONSENT_POLICY, ids, now }`, all injected through `PublicInput.consent`.
   `GET /consent/client.min.js` serves the package's `dist/client.min.js`, resolved via `import.meta.resolve`, read once and cached as an inert asset. No `banner.css` route: jini mode inlines the style.
4. Withdrawal: `DELETE /c` returns 204 with `Set-Cookie: om_visit_<port>=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` (+ Secure as in `visit()`). It writes nothing else. `inbound/http.ts:155` becomes `POST || DELETE`.
5. Hosted form (`formGet`, `public.ts:52`):
   - Inject `renderBanner({ mode: 'jini', client: { contract: 1, policy: OM_CONSENT_POLICY, regionMode: 'auto' }, copy: {} }, { clientSrc: '/consent/client.min.js', evidence: { mode: 'durable', endpoint: '/consent' }, nonce })`.
   - Put head in `<head>` and body before `</body>`.
   - Generate one nonce per response from the injected ids, and add `style-src 'nonce-…'` to the CSP. The current CSP (`default-src 'none'`) would block the banner's inline `<style>`.
   - In `formPost`, `verifyOptionalVisit` (`public.ts:87`) attaches the cookie or explicit `om_vt` visit only when `readConsent(...).allowed.marketing` is true. Otherwise the lead stays unattributed and the enquiry is still accepted.
6. Composition (`composition/index.ts`):
   - `:190` gains `|| path.startsWith('/consent')`. It joins the same `||` chain, so complexity does not increase.
   - `publicServices` (`:330`) gains `consent: { store }`. The store is `createConsentFileRecords({ directory: <localStateRoot>/consent-receipts, files: createNodeConsentFiles({ atomicWrite }) })`, with `atomicWrite` adapted from published `@jini-ai/platform/fs` (atomic-write).
   - `bootServer` gets zero new branches.
   - `inbound/http.ts` `publicRoute` gains `/consent` (POST) and `/consent/client.min.js` (GET).
7. Tracking tool (`composition/tracking.ts:17/18`):
   - Input gains `consentBanner: z.boolean().optional()` (default true: `jini`; false: `headless` for sites with their own CMP).
   - Output gains `consentBanner: z.strictObject({ head: z.string(), body: z.string() })` from the same `renderBanner` call.
   - Keep `OM_CONSENT_POLICY` and the render config in ONE exported helper in `public.ts`, used by both tracking.ts and public.ts.
8. Tests (written, not run). `ingress-worker.test.ts`:
   - no visit, cookie or touch without a `jini_choices` grant, with a pending (unconfirmed) grant, or under GPC;
   - one touch after a stored marketing grant;
   - `DELETE /c` clears the cookie;
   - the hosted GET writes nothing and has the nonce'd CSP;
   - a form POST without a grant is accepted unattributed.
   `snippet.test.ts`: adapter registered; no fetch before grant; `revoke()` sends DELETE and stops tags. `p1-tracking.test.ts`: both banner modes. `tracking.test.ts`: the studio field reaches the transport.

REUSE:
- Banner, client, receipts and gate: `@jini-ai/cookie-consent@0.6.15-rc.2`. It is published per coordinator-note, which is the authority here; source evidence is `ai-traces-jini/packages/cookie-consent/src/render/banner.ts:68` renderBanner, `server/receipt.ts:42` handleReceipt, `server/receipt.ts:104` readConsent, and `node/index.ts:47` createNodeConsentFiles. Verify the signatures against the installed rc.2 dist, not the source.
- Atomic file write: `@jini-ai/platform/fs` atomic-write (installed rc.2, `node_modules/.pnpm/@jini-ai+platform@0.6.15-rc.2*/…/dist/fs/atomic-write.d.ts`).
- Existing consent promise, landing bounds and tag activation: `features/web-events/src/snippet.ts:79-85,103-109`.
- Visit cookie and secure flag: `public.ts:28-50`. Local state root: `composition/local-auth.ts` `localStateRoot`.

DUPLICATES:
- OM's `omConsent` / `omGrantConsent` gate (`snippet.ts:99-106`) duplicates Jini's grant lifecycle. It is replaced by the Jini adapter, and `omGrantConsent` is kept only as a one-line bridge.
- Older `@jini-ai/cms/consent` (rc.2 `cms/dist/consent/node`) is superseded by cookie-consent (README: "MOVED-FROM @jini-ai/cms"). Do not use it.
- Tovu delegates its website consent to Jini (plan §5). Nothing else was found.

OWNER DECISIONS (defaults):
1. First Reject. rc.2 remembers it in the `jini_choices` cookie and stores an anonymous receipt (no IP, user agent or ID). Default: accept rc.2 behaviour. A non-identifying, strictly-necessary preference record is allowed under EDPB and ICO guidance. JINI ASK: an opt-in "memory-only reject" mode (plan's ask). Do not build OM workarounds.
2. Server gate = Jini `readConsent` on the visitor's cookie (Jini design: it gates only the visitor's own events; the receipt is the proof). Default: accept. Optional JINI ASK: `readConsent` returns the receipt id, so a host can verify the stored receipt without parsing the cookie.
3. Consent category for OM collection and attribution: default **marketing** (FIX 1).
4. Withdrawal → subject policy evidence (refuse later conversion dispatch for an already-bound subject). DEFERRED to a follow-up job. Default mapping for that job: append `withdrawal` for every currently granted consent of the visit's bound subject whose purpose is measurement or advertising. It needs a visit→subject read and an identity.ts edit.
5. Policy version: one OM constant `OM_CONSENT_POLICY` (e.g. `'2026-10-29'`), with no per-workspace setting yet.

NEEDS:
- COORDINATOR (before build): add `"@jini-ai/cookie-consent": "0.6.15-rc.2"` to `apps/server/package.json` dependencies. Hand-edit the importer in `pnpm-lock.yaml`, then `pnpm install --offline --frozen-lockfile`. web-events needs no dep: the snippet only touches `window.jiniConsentQueue`. Confirm the rc.2 exports `./render`, `./server`, `./node` and `./client.min.js`.
- JINI ASK: memory-only reject mode (OWNER DECISION 1); optionally `readConsent` exposing the receipt id (OWNER DECISION 2).
- DEFERRED: form-submission receipt metadata (needs a forms contract change); subject-level withdrawal evidence (OWNER DECISION 4).

APPROVED SCOPE for B1 (priority order; update progress.md after each item):
1. `public.ts`: the shared `OM_CONSENT_POLICY` + render helper, `POST /consent` (handleReceipt), `GET /consent/client.min.js`, the `/c` readConsent gate, and `DELETE /c` cookie clearing (FIXES 2-4). `http.ts` publicRoute and `composition/index.ts` routing + `publicServices.consent` (FIX 6).
2. `snippet.ts`: the marketing consent adapter with a real `revoke()` and the `omGrantConsent` bridge (FIX 1), with updated JSDoc documenting `jiniConsent.open()` and the footer `.jini-consent-reopen` link as withdrawal.
3. Hosted form: banner + nonce CSP in `formGet`; consent-gated attribution in `formPost` (FIX 5).
4. `tracking.ts`: the `consentBanner` input/output (FIX 7). Studio `tracking.hooks.ts` + `TrackingPage.tsx`: a banner on/off checkbox, show the head/body markup, and short text on the own-CMP bridge, the footer reopen link (withdrawal) and the proxy paths `/consent*`.
5. Tests (FIX 8). Then one typecheck each for web-events, server and studio (one re-run allowed). No tests, builds or om:check.

LOCKS-FILES: apps/server/src/inbound/public.ts, apps/server/src/inbound/http.ts, apps/server/src/composition/index.ts, apps/server/src/composition/tracking.ts, apps/server/tests/ingress-worker.test.ts, apps/server/tests/p1-tracking.test.ts, features/web-events/src/snippet.ts, features/web-events/tests/snippet.test.ts, apps/studio/src/pages/tracking/model/tracking.hooks.ts, apps/studio/src/pages/tracking/ui/TrackingPage.tsx, apps/studio/tests/tracking.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-consent-banner/progress.md (lock groups: w13-server-composition, w14-surface, w16-web-events, w22-studio-pages)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. @jini-ai/cookie-consent@0.6.15-rc.2 is now installed in apps/server (frozen lockfile). Defaults accepted: rc.2 reject behaviour (non-identifying cookie + anonymous receipt); contact-level withdrawal recording DEFERRED to a follow-up job.
