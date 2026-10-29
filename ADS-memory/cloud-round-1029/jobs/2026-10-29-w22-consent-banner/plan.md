Software Architect(Direct):

**1. Summary**

Reuse Jini’s consent banner and runtime, adding only OM’s collection, hosted-form and withdrawal wiring. Visitors get equally prominent Accept/Reject controls; rejection stays in page memory, while accepted choices require durable evidence. The hosted form uses the same consent state and still accepts enquiries without tracking permission. This is one ≤90-minute build **after the Coordinator resolves the dependency and integration NEEDS below**.

**2. Files**

Every proposed lane edit:

- `features/web-events/src/snippet.ts` — (edit) Jini adapter registration, optional banner bootstrap, existing CMP compatibility and cancellation.
- `features/web-events/src/ports.ts` — (edit) scoped stored-visit lookup and expiration operations.
- `features/web-events/src/memory.ts` — (edit) implement those operations in the existing double.
- `features/web-events/src/sql.ts` — (edit) implement those operations using existing visit storage.
- `features/web-events/tests/port-suite.ts` — (edit) shared lookup, expiration, scope and replay regressions.
- `features/web-events/tests/snippet.test.ts` — (edit) consent, receipt failure and withdrawal regressions.
- `features/web-events/README.md` — (new) banner setting, CMP calls, withdrawal and proxy paths.
- `apps/server/src/inbound/public.ts` — (edit) Jini receipt/assets/rendering boundary, receipt-backed collection gate and hosted-page markup.
- `apps/server/tests/ingress-worker.test.ts` — (edit) existing fixtures and consent/withdrawal integration regressions.
- `apps/studio/src/pages/tracking/model/tracking.hooks.ts` — (edit) optional banner setting in the existing snippet request.
- `apps/studio/src/pages/tracking/ui/TrackingPage.tsx` — (edit) setting and concise installation/withdrawal instructions.
- `apps/studio/tests/tracking.test.ts` — (edit) setting reaches the existing tool transport.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-consent-banner/progress.md` — (new) implementation progress.

Hosted-page rendering currently lives in `public.ts`; no forms-rendering relocation.

**3. Public contracts**

- Extend `webEventInstallSource({ collectionPath, tags?, consentBanner? }): Outcome<string>`.
- Preserve `webEventSnippetSource({ collectionPath, tags? }): Outcome<string>` and existing CMP entry points.
- Document `window.omGrantConsent()` as the compatibility bridge into Jini’s durable grant.
- Document `window.jiniConsent.open()` and `window.jiniConsent.set({ action: 'withdraw' })`.
- Extend existing `WebEventRepoPort`:
  - `findVisit({ context, visitId }, options?): Promise<Outcome<Visit | undefined>>`
  - `expireVisit({ context, visitId }, options?): Promise<Outcome<void>>`
- Existing `om_web_events_snippet` gains optional `consentBanner: boolean` through its existing schema and HTTP/tool/CLI transport.
- Reuse Jini’s `ConsentAdapter` and receipt contracts; derive new OM boundary types from Zod.

**4. Approach**

1. **Dependency preflight:** inspect installed `@jini-ai/cookie-consent@0.6.15-rc.2` after Coordinator installation. Verify the two package concerns in §8 before implementation; do not patch or copy Jini.
2. Use Jini’s built-in banner when requested and its headless mode for existing CMPs. Force opt-in behavior. OM collects nothing at `anonymous` or `none` levels; GPC/DNT remain effective.
3. Keep existing bounded landing capture in page memory. Register the collector as an analytics adapter and admitted tag activation as a marketing adapter. Start only from Jini’s effective permissions after durable receipt confirmation.
4. Pass Jini’s abort signal through collection and check it between tag activations. Collector revocation stops further work. Tags that cannot be unloaded report unsuccessful cleanup so Jini performs its existing reload behavior.
5. Mount Jini’s renderer/client/receipt handler through injected server dependencies. `/c` requires current stored receipt evidence; `consent: true` alone no longer authorizes collection. Validate policy, expiry, effective category and privacy signals before issuing a visit or recording a touch.
6. Add the same Jini UI to `/f/:slug`; GET remains free of visit/cookie writes. Preserve submission without consent. Existing published, purpose-specific form checkboxes remain separate from tracking permission.
7. Add stored-visit lookup and expiration to both repositories. Retain the visit binding and historical attribution; expiration prevents later collection/binding with the withdrawn token. Exact save replay must not restore expiration.
8. The Coordinator-owned withdrawal binding resolves the stored subject, serializes with dispatch, appends destination/purpose withdrawal evidence and expires the visit. Clear OM’s HttpOnly cookie server-side. A successful response must mean withdrawal is durable; a failure must not claim server revocation.
9. Write regressions for: no pre-consent effects, memory-only first rejection, one collection after acceptance, failed/missing/retired receipts, GPC/DNT, hosted attribution, withdrawal during pending work, cookie clearing, old-token reuse and dispatch refusal.
10. Run one typecheck each for web-events, server and studio; one rerun only after fixing reported errors. No tests, builds or `om:check`.

**5. Reuse**

- **OM:** existing consent promise, landing bounds and tag activation in `features/web-events/src/snippet.ts`.
- **OM:** `visitCookie`, `visit`, `verifyOptionalVisit` and hosted rendering in `apps/server/src/inbound/public.ts`.
- **OM:** SQL `readVisit`, `visitSchema`, binding checks and existing memory/SQLite shared suite.
- **OM:** policy evidence and subject serialization in `apps/server/src/composition/identity.ts`, `forms.ts` and `subject-lane.ts`; no second consent ledger or dispatch gate.
- **Jini:** `@jini-ai/cookie-consent@0.6.15-rc.2`, identified by this job’s `coordinator-note.md`: renderer, client lifecycle, receipt handler and receipt storage.
- Searched `/Users/la/Programming/Jini/CAPABILITIES.md`, Jini consent sources and Tovu’s website consent feature. Tovu delegates its mechanism to Jini.
- Also inspected the newer `ai-traces-jini/packages/cookie-consent` implementation read-only. It is **reference evidence, not verification of rc.2**.
- Rejected older `@jini-ai/cms/consent`, a new OM CMP, copied sibling code and another OSS dependency. Registry verification was attempted but unavailable.

**6. Deliberately left out**

- Banner designer, custom CSS controls, region services, vendor consent-mode adapters and anonymous analytics.
- New registries, factories, queues or generic consent interfaces.
- Vendor cookie cleanup without an existing declared adapter contract.
- **DEFERRED:** additional tracking-receipt metadata persisted alongside form submissions. The current forms contract has no such field; implementing its validation, digest and worker propagation exceeds this run. Existing published checkbox evidence remains intact.
- No claim that withdrawal recalls an already-started vendor request.

**7. NEEDS**

- **COORDINATOR:** add `@jini-ai/cookie-consent@0.6.15-rc.2` to `apps/server/package.json` and update `pnpm-lock.yaml`; verify published exports before releasing this build.
- **JINI ASK:** verify/add an opt-in mode where first rejection writes no cookie, storage or durable visitor receipt; retain denial in memory and still durably record withdrawal after acceptance. The readable source persists every choice.
- **COORDINATOR:** provide injected receipt storage, policy version, clock/IDs and package assets to `public.ts`; reuse Jini’s storage adapter.
- **COORDINATOR:** allow and route exact consent client/banner GETs and receipt POSTs in `apps/server/src/inbound/http.ts` and `composition/index.ts`. Add no branch to `bootServer`.
- **COORDINATOR:** extend `composition/tracking.ts`’s existing input schema and pass `consentBanner`; cover parity in `tests/p1-tracking.test.ts`.
- **COORDINATOR:** bind withdrawal in `composition/identity.ts` using the existing subject lane and transaction boundary. Ensure delayed form acceptance preserves the enquiry when its visit has since expired/been withdrawn.
- **COORDINATOR:** rebuild affected runtime artifacts after integration. No migration or shared-contract change is proposed.
- These are prerequisites; this lane must not substitute weaker browser-only revocation.

**8. Unverified facts and risks**

- rc.2 cookie-consent is absent from OM. Publication is Coordinator-reported; npm endpoints were inaccessible. Confirm signatures and behavior against installed rc.2, not sibling source.
- Readable Jini `readConsent` describes the cookie as an assertion, not proof. Collection must additionally validate active stored evidence. Verify retirement failures cannot leave an old receipt usable; unresolved behavior becomes a **JINI ASK**, with collection denied.
- Remembering refusal can qualify as essential preference storage in some circumstances, but OM’s owner rule is stricter. Choose **page-memory rejection**, accepting that another page may ask again. Withdrawal must remain easy to access. [EDPB cookie-banner report](https://www.edpb.europa.eu/system/files/2023-01/edpb_20230118_report_cookie_banner_taskforce_en.pdf), [ICO consent guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/consent/how-should-we-obtain-record-and-manage-consent/).
- Expired/missing visit identity cannot prove which subject to revoke. Never accept a browser-supplied subject ID or report durable subject withdrawal without that binding.
- **DISPUTED:** pre-consent collection is already fixed: `snippet.ts:85`, `public.ts:20` and `public.ts:56–61`. Extend these paths; do not redo W21.

**9. Size estimate**

13 lane files: approximately **300–420 source LOC added, 40–80 removed; 220–300 test LOC added**. One ≤90-minute implementation run after prerequisites, with form receipt-metadata propagation explicitly deferred. This planning run changed no files and ran no checks.