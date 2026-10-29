# Progress: 2026-10-29-w22-contacts-meta-identifiers (builder A, after w22-consent-banner)

1. DONE dispatcher superset rule (features/measure/src/delivery/dispatcher.ts resolveIdentifiers): subject must match and every committed identifierDigests key must exist in the evidence with an equal value; the RESOLVED identifiers + identifierDigests (superset) are forwarded only in the transient input. Committed event, eventIdentity, deliveryIdentity and ledger unchanged; refusal message kept. Memory consent double (memory.ts): `phone` evidence also covers `phone_digits`; withdrawal precedence unchanged. Tests: delivery.test.ts (legacy {email, phone} commit + 5-key resolver dispatches once with all five keys, ledger has no raw values; changed committed digest and missing committed key refuse), boundaries.test.ts (phone covers phone_digits; email-only evidence does not; withdrawal still wins). Job item (2) production writer: DISPUTED per review (no production writer of identifierKeys).
2. DONE web-events storage: landingPropertiesSchema gains `client_user_agent` (<=1024); touchSchema clickIdentifiers gains `client_user_agent` / `event_source_url` (<=1024); mapTouch stores them only as a PAIR (UA + query/fragment-free origin+path of pageUrl, each <=1024), click-key loop unchanged; canonicalClicks / replay digest include both keys; types.ts doc line fixed. No migration; purgeSubject already clears the map. Tests: port-suite (pair stored/replayed, changed UA conflicts, lone UA not stored and refused if forged into the touch, purge clears) + fixtures touch() mirrors the pair. web-events dist rebuilt; measure dist rebuilt.
3. DONE capture + enrichment: public.ts landingSchema omits client_user_agent (browser-supplied -> 400); `userAgentProperty` adds trimmed 1..1024 `user-agent` header server-side inside landingProperties, i.e. only after the consent gate (gate lines untouched). Collection allowlist in identity.ts is derived from landingPropertiesSchema keys, so it includes client_user_agent automatically. identity.ts `identifiersFor` = contacts.identifiersFor, then on ok `withWebsiteContext` (exported helper): newest touch (30 days, limit 10) with both keys adds raw values + destinationIdentifierHash digests; none/unreadable adds nothing; contacts denial/failure unchanged. Test (ingress-worker): ungranted /c 403, spoofed client_user_agent 400, consented /c stores only the pair in web_touch (not in web_event), enrichment after form binding, unbound subject unchanged, erasure clears the map and enrichment adds nothing afterwards.
DEFERRED: capture on a form submit without a consented touch (per review NEEDS).

## TYPECHECK
- `pnpm --filter @open-marketing/measure typecheck` -> pass
- `pnpm --filter @open-marketing/web-events typecheck` -> pass
- `pnpm --filter @open-marketing/server typecheck` -> pass

## TESTS
- measure `vitest run` (whole package) -> 419/419 pass
- web-events `vitest run` (whole package) -> 111/111 pass
- server `vitest run tests/ingress-worker.test.ts` -> 39 pass, 3 fail; the 3 also fail on the untouched baseline copy (bare campaign id fixture, sandbox-agent boot, 'holds form withdrawal' contacts unavailable). New test passes.
- server agent-plugin-jobs / catalog-composition / message-send / messaging-webhooks (identity users): failure set identical to baseline copy (22 baseline failures; one transient extra run during a concurrent rebuild did not reproduce).

NET LINES: +168 −16 (incl. ~6 public.ts and ~42 ingress-worker.test.ts lines for this job)
