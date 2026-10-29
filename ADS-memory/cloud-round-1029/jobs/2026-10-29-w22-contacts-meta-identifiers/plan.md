Software Architect(Direct):

**1. Summary**

New consented website touches will retain the browser user agent and sanitized page URL for conversion delivery. Form acceptance will bind those touches to the contact through the existing visit flow, and erasure will clear their raw values. Consent coverage will include `phone_digits` whenever it includes `phone`. Older conversion commits will dispatch using their original identifier set; missing historical website metadata will remain “not sent.”

**2. Files**

All paths below are proposed build locks; this planning run changed nothing.

- `features/web-events/src/types.ts` — (edit) bounded optional website identifier schemas and documentation.
- `features/web-events/src/rules.ts` — (edit) map website identifiers into mutable touches and include them in replay validation.
- `features/web-events/tests/fixtures.ts` — (edit) extend existing touch fixture for the two website keys.
- `features/web-events/tests/port-suite.ts` — (edit) shared memory/SQL assertions for storage, isolation, replay and erasure.
- `features/web-events/tests/adapters.test.ts` — (edit) prove raw website values stay outside immutable envelopes and are physically purged.
- `features/measure/src/rules.ts` — (edit) allow the existing 2048-character URL bound through identifier validation.
- `features/measure/src/delivery/dispatcher.ts` — (edit) validate current evidence, then project only committed identifiers.
- `features/measure/src/memory.ts` — (edit) derive consent evidence types from Zod and normalize the phone alias at evidence intake/replacement.
- `features/measure/tests/delivery.test.ts` — (edit) legacy-key-set regression and unchanged refusal/reconciliation assertions.
- `features/measure/tests/boundaries.test.ts` — (edit) phone alias consent coverage and browser-field denial cases.
- `apps/server/src/composition/identity.ts` — (edit) enrich the existing identifier adapter from bound consented touches.
- `apps/server/src/composition/forms.ts` — (edit) persist identifier coverage supplied by immutable consent descriptors, after the prerequisite below lands.
- `apps/server/src/inbound/public.ts` — (edit) capture request UA and origin-validated page URL after consent parsing.
- `apps/server/tests/ingress-worker.test.ts` — (edit) capture, binding, consent-record and erasure regressions; identifier-adapter fixtures.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-contacts-meta-identifiers/progress.md` — (new) completed-item ledger.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-contacts-meta-identifiers/report.md` — (new) results, actual line counts, checks and handoff.

**3. Public contracts**

- Keep `ContactService.identifiersFor({ context, subjectId, destination, purpose }, options?)` unchanged.
- Keep `ConversionIdentifiersPort.identifiersFor({ context, subjectId, destination, purpose }, options?)` unchanged.
- Extend `LandingProperties` through Zod with optional `client_user_agent` and `event_source_url`; retain `AttributionTouch.clickIdentifiers`’ existing map shape.
- Server-local `resolveConversionIdentifiers({ contacts, webEvents, clock, input }, options?): Promise<Outcome<DestinationIdentifiers>>` owns enrichment. Its concrete replacement adapters are the contact/touch fixtures needed to exercise success while production sandbox sharing remains denied.
- Keep `createMemoryMeasurementShareability({ clock?, evidence? })` and `replace({ evidence })` signatures unchanged.
- No new HTTP route, tool, CLI command, feature export, port or factory.

**4. Approach**

1. **Resolve the consent prerequisite first.** Current durable policy/form schemas cannot record identifier coverage; see NEEDS. Do not create a parallel consent store or enable browser-field sharing without that coverage.
2. **Capture through the existing consented `/c` path.** After literal `consent: true` parses, read the request’s `user-agent` header, bounded to 1024 characters. Reuse `heartbeatProperties`’ origin check and query/fragment stripping for the HTTPS page URL, bounded to 2048 characters. Reject caller-supplied replacements for these server-derived fields.
3. Extend the existing mutable `web_touch.click_identifiers` JSON allowlist with the two keys. Keep browser query `clickKeys` unchanged. `storedEvent` continues excluding raw values; existing memory/SQL purge operations clear the entire mutable map. No migration.
4. Extend the server’s existing collection allowlist and identifier adapter. Reuse the bounded, newest-first touch reader after W22-NEWEST-FIRST-TOUCH lands; take UA/URL together from one touch. Reuse contacts’ `destinationIdentifierHash` for evidence digests while supplying the raw validated values transiently. Preserve missing-contact, suppression and local-sandbox denial behavior.
5. In form acceptance, copy declared identifier coverage from the immutable consent descriptor. Normalize `phone` coverage to also list `phone_digits`; never add UA/URL coverage to old wording or unrelated consent.
6. Normalize the same phone alias in the memory consent double at initial evidence intake and `replace`. Preserve its exact scope/purpose/destination checks and withdrawal precedence. Browser keys still require explicit coverage.
7. Fix dispatch locally: first reject inconsistent resolver identifier/digest maps; then require every committed digest to exist and match current evidence. Pass only committed keys to delivery/reconciliation. **Do not change `eventIdentity`, committed events, delivery identities or ledger records.**
8. Write regressions: legacy `{email, phone}` plus a valid resolver superset dispatches once; uncommitted extras are omitted; changed/missing committed evidence and malformed maps still refuse. Cover explicit UA/URL consent, no-consent zero writes, URL sanitization, erasure and a URL longer than 1024 characters.
9. At completion, run one package-scoped typecheck each for web-events, measure and server, with one corrective rerun allowed. Write tests without running them; no builds, installs or `om:check`.

**5. Reuse**

- Capture: `public.ts`’s `collect`/`heartbeatProperties`; the existing snippet already supplies `pageUrl` behind its collection consent gate.
- Storage/erasure: web-events `mapTouch`, `replayDigest`, `storedEvent`, both existing repositories and `purgeSubject`.
- Identity/digests: contacts’ existing destination projection and `destinationIdentifierHash`; no new contacts storage or hashing implementation.
- Dispatch: existing verified-inbox, grant, consent, claim and reconciliation paths; change only identifier resolution.
- Tests: existing web-events shared repository suite and measure/server fixtures.
- Searched Jini’s `CAPABILITIES.md`, Jini packages and Tovu apps/packages for website keys, phone aliases and identifier coverage; no matching implementation found.
- Inspected installed `@jini-ai/cms@0.6.15-rc.2` consent declarations and Tovu’s `features/consent/service.ts`: category receipts do not provide OM’s subject/destination identifier coverage.
- Rejected Jini analytics normalization for this task: `packages/analytics/src/ingest.ts` deliberately removes raw UA.
- npm registry verification was attempted but unavailable through both web access and sandbox DNS. No dependency addition is proposed.

**6. Deliberately left out**

- New tables, migrations, registries, capture ports, retries, caching or vendor branches.
- Changes to contacts’ identifier-kind enum and its SQL constraint; mutable touch storage already fits.
- Historical UA/URL backfill or adding fresh identifiers to old commits.
- Consent banner, withdrawal UI, conversion settings, delivery diagnostics and worker wiring: other W22 jobs own them.
- **DEFERRED:** form-submit-only metadata capture without a consented touch. Forms currently has no corresponding acceptance metadata contract; extend it only through its owner if the banner/touch flow does not cover that case.

**7. NEEDS**

- **DESIGN NOTE — Coordinator/policy owner:** durable `Consent` lacks `identifierKeys` (`features/policy/src/validation.ts:9`); only measure’s memory double has it (`memory.ts:14–34`). Add bounded optional identifier coverage to existing consent evidence and enforce it through canonical conversion dispatch. Missing coverage must not authorize the new UA/URL fields.
- **Coordinator/forms owner:** add the same bounded `identifierKeys` metadata to immutable `ConsentWording`/`ConsentCapture`; new website coverage needs matching wording/version. Preserve historical publication content.
- **Coordinator/measure adapter owner:** forward committed identifier keys from `features/measure/src/adapters/capabilities.ts` into canonical policy’s conversion decision, with regression assertions. This file is outside this lane.
- **W22-CONSENT-BANNER:** collection consent evidence must cover UA/URL before this capture path is enabled.
- Serialize after W22-NEWEST-FIRST-TOUCH and coordinate overlapping `forms.ts`, `identity.ts`, `public.ts` and ingress-test locks with the banner job.
- Lock the actual dispatcher path, `features/measure/src/delivery/dispatcher.ts`; there is no `src/dispatcher.ts`.
- Coordinator rebuilds changed runtime artifacts later. Installs, package manifests, lockfile changes and migration registration: none proposed.

**8. Unverified facts and risks**

- Verified current defects: full-key comparison at dispatcher lines 58–60 rejects the phone alias superset; consent intake does not normalize the alias; public capture currently drops website identifiers.
- **DISPUTED scope assumption:** there is no production `identifierKeys` writer to amend locally; durable coverage requires the changes above.
- Existing Meta missing-UA/URL refusal is already implemented in `capi.ts`; preserve it. The [primary parameter reference](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event) returned HTTP 429, so vendor requirements were not independently reconfirmed.
- Touch changes between commit and dispatch can change evidence; mismatches continue to refuse. Missing metadata stays absent, never synthesized.
- Local sharing remains denied, and external worker wiring remains separate; this run establishes no live-delivery proof.

**9. Size estimate**

One ≤90-minute build **after consent prerequisites and overlapping locks are resolved**: 14 code/test files plus two job records. Roughly +160–220/−30–60 source LOC and +220–280/−10–30 test LOC; estimated net +290–460. Prioritize consented capture/enrichment and erasure, then phone coverage and legacy dispatch; report any unfinished tail explicitly.