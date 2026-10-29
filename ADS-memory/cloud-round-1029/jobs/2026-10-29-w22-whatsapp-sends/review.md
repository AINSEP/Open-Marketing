# Trim review: 2026-10-29-w22-whatsapp-sends
VERDICT: APPROVED WITH CUTS

No coordinator-note.md exists in this job directory, so plan.md and this review are binding. The plan's core is right. The host path at agent-plugin-backends.ts:137-237 is already channel-generic and needs no source edit. The plan replaces broadcast.ts in place with the Twilio `sendMessage` ABI. Free-form sends are refused. Meta's template status and WABA currency are checked before authority. The cuts below remove a new npm dependency and a contended server test, and they unblock the build when Meta's rate numbers cannot be fetched.

CUTS:
1. **`libphonenumber-js` and its Coordinator NEEDS (package.json/lockfile).** Meta assigns the pricing market from the recipient's *country calling code plus listed area-code prefixes*, not from an ISO country. Its official pricing page has the in-page table "Pricing regions on the rate card (country calling codes)": US/CA = +1; Dominican Republic, Jamaica and Puerto Rico are split by NANP prefixes (809/829/849, …); Russia and Kazakhstan both use +7; unlisted countries map to "Other" (https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md, fetched 2026-10-29). libphonenumber would return an ISO country that still needs a second mapping onto Meta's markets, so it adds a dependency without answering the question. Use a plugin-local prefix table instead (FIX 2). No plugin package.json change, no lockfile change, no bundle growth.
2. **`apps/server/tests/message-send.test.ts` edits.** The host is channel-generic. agent-plugin-backends.ts:188 reads the module's `messageChannel`; :174 passes it to `dispatchDecision`; policy gates.ts:49 and :66 match suppression and consent on `channel.id`. WhatsApp STOP webhooks already emit `channel: "whatsapp"` (webhooks.ts:39, 93), and messaging-webhooks.ts:36 stores suppression under `event.channel`. The existing sms tests cover card contents (`card.arguments` equals the exact input, including `message`), STOP after the card, and consent-missing. A WhatsApp copy using a fake module adds little, and the file falls under lock group w15-backends ("+ its tests"), which w22-sms-composer and w22-conversion-delivery-diagnostics hold because they edit agent-plugin-backends.ts. Assert `messageChannel === "whatsapp"` in the plugin test instead.
3. **The plan's "STOP-after-card" server regression.** Already covered: message-send.test.ts:101-113.
4. **Blocking the whole job on rate evidence.** The rest of the build goes ahead: template check, currency check, prefix mapping, quote math, ABI and tests. If verified USD numbers cannot be obtained, see OWNER DECISIONS 1.
5. **Extra job-dir record `typecheck.txt` "edit" as a scope item.** Keep it only as the typecheck log. It is not a deliverable.

FIXES:
1. **Send ABI = the Twilio shape exactly** (twilio-sms/.../src/broadcast.ts:11-34, :40-74). Export `messageChannel = "whatsapp"` and `sendMessage(required: WhatsAppMessage & { dependencies }, optional?)`. Parse `{ context, deliveryId, recipient, message: { template: { name, language, bodyParameters } } }` with a strictObject, so the host's `message` record (agent-plugin-backends.ts:210) is validated. Reuse the existing template regexes at broadcast.ts:11-13. `authority` becomes `{ quote, argumentsDigest, execute }` only: drop the cloned `configuration`/`request`/recipient fields at broadcast.ts:28 and :63 (the host parses only quote and digest, agent-plugin-backends.ts:223). Define the send dependencies in broadcast.ts as `Pick<PluginCapabilityDependencies, "configuration"|"credentials"|"fetch"|"clock"|"observer"> & { deadlineSignal; authority }`. Do NOT edit ports.ts; the read adapter keeps `createDeadline`. Replace `d.createDeadline` at broadcast.ts:79 with `d.deadlineSignal`.
2. **Pricing table (`rates.ts`, data plus one pure function).**
   - Keys are Meta's calling-code prefixes, transcribed from the official .md page above. Values are market names. Each market has decimal-string USD list rates per category exactly as Meta publishes them (`marketing`, `utility`, `authentication`, and optionally `authenticationInternational`), plus one `effectiveDate` ("2026-10-01") and the source URL.
   - Use a longest-prefix match on the E.164 digits.
   - **No match: use the highest rate in the table for that category** (a conservative stand-in for "Other"). This keeps the quote an upper bound even when the transcribed mapping is partial.
   - For authentication, use max(authentication, authenticationInternational) when the market has the latter. Eligibility is notice-based (pricing page, "Authentication-international").
   - Convert with contracts `decimalToMicros({ rounding: "reject" })`, the same as twilio broadcast.ts:131, and take the ceiling in cents, `(micros + 9999n) / 10000n`, the same as twilio :122.
   - Volume tiers only lower prices, so list rate is a valid upper bound. Utility templates are billed even inside an open service window from 2026-10-01, so don't model a free window.
   - An empty table or a missing category rate returns `not_implemented` BEFORE authority, so nothing is reserved.
3. **Pre-authority reads.** Make exactly two GETs through one small local `readGraph`, the same as twilio `readPricing` (:139-149), using the existing `readBody` (transport.ts) and `apiVersion`:
   - (a) `/{wabaId}?fields=currency`. Anything other than "USD", or a missing field, refuses `not_implemented`.
   - (b) `/{wabaId}/message_templates?fields=id,name,language,status,category&name=<name>&limit=100`. Parse it with the EXISTING `templatesSchema` (commands.ts:22-25); don't write a new schema. Require exactly one row with exact `name` + `language`, `status === "APPROVED"`, and category MARKETING|UTILITY|AUTHENTICATION. Zero matches, more than one match, or no match while `paging.next` is present refuses with `forbidden`. No pagination loop.

   Access credentials once per call (existing broadcast.ts:55-62) and reuse that credential for both GETs and the POST.
4. **Quote.** Build it from the `generationCostQuoteSchema.pick(...)` subset, the same as twilio :22 and :124-125. `pricingEvidenceId` = sha256 of `[effectiveDate, matchedPrefix|"max", category, rateString]`, and `expiresAt` = now + 300000. Compute `argumentsDigest` over the frozen POST request (existing broadcast.ts:64).
5. **Price evidence.** Try Meta's pricing page and its "USD list rates (CSV)" link once (WebFetch). The in-page mapping table is reachable; on 2026-10-29 the CSV hrefs were not exposed, and whatsappbusiness.com/products/platform-pricing loads rates interactively. Populate rates ONLY from a primary Meta source. Never use third-party blogs. Record the URL, date and what was or wasn't verified in `evidence/primary-sources.json`.
6. **Observer operation name.** Rename `whatsapp-business.broadcast` to `whatsapp-business.send` (broadcast.ts:111), the same as twilio :189.

REUSE:
- Host approval, consent, suppression, reservation and settlement: apps/server/src/composition/agent-plugin-backends.ts:137-237 (unchanged).
- Send ABI and quote shape: content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/broadcast.ts:11-34, :109-149. Mirror it; plugins never import each other.
- Template status parsing: whatsapp `commands.ts:22-25` `templatesSchema`. Bounded body read: `transport.ts` `readBody`. Credential parsing: `transport.ts` `parseCredential`.
- Single-shot POST, receipt and redaction: existing whatsapp `broadcast.ts:73-108`, kept.
- Money: contracts `decimalToMicros` (packages/contracts/src/metrics/index.ts:13) and `moneySchema`/`generationCostQuoteSchema` (capabilities/index.ts:15).

DUPLICATES:
- Searched published Jini 0.6.15-rc.2 (node_modules/.pnpm/@jini-ai+*@0.6.15-rc.2*/…/dist) for whatsapp, message_templates, libphonenumber, callingCode and rate card. There are no WhatsApp, template or pricing mechanisms. The only "rate card" hit is unrelated mcp-ui outcome-surface prose (@jini-ai/ui dist/features/mcp-ui/surfaces/outcome.d.ts:96).
- Tovu (apps/, packages/): the only "whatsapp" hit is i18n text (apps/admin/src/features/seo/seo-i18n.ts). ai-traces-jini source: the same, i18n only (packages/admin/src/seo/messages.en.ts).
- The OM-internal duplicate is CUT 1: libphonenumber-js is in features/contacts/src/normalize.ts:2. It isn't reused because Meta's mapping is by calling-code prefix.
- No JINI ASK. WhatsApp pricing and template checks are vendor-specific, so they stay plugin-local.

OWNER DECISIONS (defaults):
1. **Unverifiable rate numbers.** Default: ship everything with the rates table holding only primary-verified rows. If there are none, every send refuses `not_implemented` before reservation (fail-closed). Report this NEEDS line: "OWNER: download Meta 'USD list rates (CSV)' (effective 2026-10-01) from developers.facebook.com/documentation/business-messaging/whatsapp/pricing into this job dir; a follow-up fills rates.ts."
2. **Rate staleness.** Default: no automatic expiry. `effectiveDate` is inside `pricingEvidenceId` so it can be audited, and the README says Meta revises rates quarterly (the next change could raise them).
3. **Intent vs template category.** The host passes `intent` to policy, but it doesn't pass it to the plugin (agent-plugin-backends.ts:210). So a MARKETING template sent with intent "transactional" would skip marketing holdout and purpose gates, unless the owner catches it on the card. This applies to SMS too, so it's a general host issue. Default: no host change in this job. Report a DESIGN NOTE/NEEDS line: "host passes `intent` to sendMessage; WhatsApp refuses a MARKETING-category template under transactional intent" for a later w15-backends job, coordinated with Twilio's strict schema.
4. Free-form sends: refuse, as planned. Meta's 24-hour window can't be proven from OM state.
5. Production stays read_only. The tool is unavailable until the owner enables production plugin mode, which is unchanged from w20.

APPROVED SCOPE for B1:
1. `src/broadcast.ts`: in-place rewrite to `messageChannel = "whatsapp"` plus `sendMessage` (FIX 1). Pre-authority currency and template GETs (FIX 3), quote (FIX 4), the existing single-shot POST/receipt/redaction kept, observer renamed (FIX 6). Remove `definitionId`/`subjectId` and `deliverWhatsAppBroadcastRecipient` with no wrapper. Complexity ≤10 and nesting ≤3 per function.
2. `src/rates.ts` (new): prefix→market table, per-market USD decimal strings, effectiveDate and source URL, plus one pure `maximumRate({ digits, category })` returning micros as an Outcome (FIX 2). Populate it from primary evidence only (FIX 5 / OWNER DECISIONS 1).
3. `src/index.ts`: export `sendMessage`, `messageChannel`, `whatsappMessageSchema`, `whatsappDeliveryReceiptSchema` and the inferred types. Drop the broadcast exports.
4. `tests/fixtures.ts` + `tests/broadcast.test.ts` (written, NOT run):
   - Migrate the existing assertions to `sendMessage`.
   - Add these cases:
     - (a) A non-APPROVED, missing, wrong-language or ambiguous template refuses with no authority call and no POST.
     - (b) A non-USD WABA refuses before authority.
     - (c) Prefix mapping, longest-prefix NANP exception and no-match→max cases produce the expected ceiling-cent upper bound.
     - (d) An empty table refuses `not_implemented` before authority.
     - (e) Authority denial means no POST.
     - (f) Credential and token text never appears in outcomes.
     - (g) `messageChannel === "whatsapp"`.
   - When rates are unverified, tests use a fixture table injected through the function's arguments, not production numbers.
5. `evidence/primary-sources.json`: pricing.md mapping source, rate-card status and date (FIX 5).
6. `README.md` + `skills/whatsapp-business/SKILL.md`: replace the "no send tool / broadcast" text with "send one approved template via `om_message_send`; free-form refused; quote = Meta list-rate upper bound". Keep it short.
7. progress.md after each item, then report.md with:
   - NEEDS: Coordinator rebuilds the whatsapp dist and digest; OWNER DECISIONS 1 and 3.
   - DEFERRED: free-form/24h window, media/header/button parameters, broadcasts, billed-price reconciliation, server WhatsApp test (CUT 2).
   - Net LOC.

   Run one typecheck: `corepack pnpm --dir content/agent-plugins/whatsapp-business typecheck`, with one re-run allowed. No server typecheck, because no server files change. No tests, builds or om:check.

LOCKS-FILES: content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/broadcast.ts, content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/rates.ts, content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/index.ts, content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/tests/broadcast.test.ts, content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/tests/fixtures.ts, content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/evidence/primary-sources.json, content/agent-plugins/whatsapp-business/README.md, content/agent-plugins/whatsapp-business/skills/whatsapp-business/SKILL.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/progress.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/report.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/typecheck.txt (lock groups: w22-whatsapp)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted: plugin-local longest-prefix market table; unmatched → highest category rate (upper bound); only primary-Meta-sourced rates; no verified rows → refuse before reserve; OWNER NEEDS line for the USD list-rates CSV. Typecheck: plugin only (typecheck.txt server step may be skipped: no server files change). Intent→plugin gap DEFERRED to a later w15-backends job.
