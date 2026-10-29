### 2026-10-29-w22-whatsapp-sends: verdict READY TO COMMIT (one latent-risk fix recommended before any rate rows are added)

Paths: content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/ (abbreviated `wa/`). The job's files are the ones with 10-29 mtimes: broadcast.ts, rates.ts, index.ts, tests/broadcast.test.ts, tests/fixtures.ts, README.md, SKILL.md and evidence. transport.ts, ports.ts, plugin.json and the dispatch tests are dirty from earlier waves (mtimes 10-25 to 10-28), not from this job.

Ledger:
- APPROVED 1, broadcast.ts → sendMessage (FIX 1, 3, 4, 6): FIXED.
  - wa/src/broadcast.ts:12 `messageChannel = "whatsapp"`.
  - :14-17 strict `{ context, deliveryId, recipient, message: { template: { name, language, bodyParameters } } }`; free-form is refused by the strict schema.
  - :31-35 dependencies = `Pick<…>` + `deadlineSignal` + `authority({ quote, argumentsDigest, execute })`, with no cloned config or request.
  - :67 accesses the credential once per call, and :91/:96/:139 reuse it.
  - The currency GET (:91-93) refuses non-USD/missing with `not_implemented`. The template GET (:95-104) reuses `templatesSchema`: exactly one exact name+language row, `paging.next` absent, APPROVED, and a category in M/U/A, otherwise `forbidden`.
  - Quote at :105-110: ceiling cents `(micros+9999n)/10000n`, `pricingEvidenceId` = sha256 of [effectiveDate, prefix|"max", category, rate], expiry 300 s, and the digest is computed over the frozen POST (:72, :76).
  - The observer is renamed `whatsapp-business.send` (:167).
  - The old broadcast API is removed with no wrapper. No `rg` hits remain for `deliverWhatsAppBroadcastRecipient`/`definitionId`/`subjectId` in src.
- APPROVED 2, rates.ts (FIX 2, 5, OWNER DECISION 1): FIXED. Production rows are empty, as required.
  - `usdRates = {}` (wa/src/rates.ts:16).
  - `maximumRate` (:33-50) does a longest-prefix match. No match takes the max over all markets. Authentication takes max(domestic, international). It uses `decimalToMicros({ rounding: "reject" })`, and a missing category or empty table returns `not_implemented`.
  - With the empty table, a "1…" number maps to a market with no row, and anything else maps to zero rows. Both return `not_implemented` inside `priceQuote`, BEFORE `d.authority` (broadcast.ts:106 then :79), so nothing is reserved. Verified by the test at broadcast.test.ts:178-181 (authority 0, no calls).
- APPROVED 3, index.ts exports: FIXED (wa/src/index.ts:3-4).
- APPROVED 4, tests (written, not run): FIXED. broadcast.test.ts has cases (a)–(g):
  - :11 channel;
  - :120/:143 template refusals;
  - :138 non-USD;
  - :16-26 prefix, NANP, max and auth;
  - :178 empty table;
  - :69 authority denial with no POST;
  - :213 redaction.
  - Fixture rates are injected through the optional argument, not the production table.
- APPROVED 5, evidence/primary-sources.json: FIXED. It records the reachable and unreachable Meta pages dated 2026-10-29 and says no numeric rows were verified.
- APPROVED 6, README + SKILL: FIXED. Both describe `om_message_send`, approved templates only, free-form refused and the list-rate upper bound, and say sending currently refuses.
- APPROVED 7, progress/report/typecheck: FIXED. Typecheck PASS on the corrective rerun (typecheck.txt).
- COORDINATOR OVERRIDE 1: FIXED. Prefix table, unmatched → max, primary-only rows, refuse before reserve, OWNER NEEDS line present; plugin-only typecheck; intent gap DEFERRED.

Outside lane: none. There are no server, ports.ts, transport.ts, manifest, lockfile or contracts edits by this job.

New:
- [MINOR, latent; becomes MAJOR the day rate rows are added] wa/src/rates.ts:21 maps the whole `"1"` prefix to "North America", but only 1809/1829/1849 are carved out.
  - Meta's rate card splits more NANP codes into other markets. The plugin's own comment and progress.md say "Complete the remaining NANP exceptions".
  - Failure: once `usdRates` gets rows, a +1-876 (Jamaica) or +1-787 (Puerto Rico) recipient matches "1" and is quoted at the North-America rate, so the "upper bound" can under-quote and the reservation is short.
  - Fix: delete the `"1": "North America"` entry until the full NANP list is transcribed. Unmatched +1 numbers then take the max-rate path, which is a safe upper bound. Keep the 1809/1829/1849 rows, and adjust the one prefix test that expects "North America".
- [MINOR] wa/src/broadcast.ts:37 `MessageOptions = CallOptions & { rates?: Rates }`. A pricing override is reachable through `sendMessage`'s public optional argument.
  - The host passes only `{ signal }` (agent-plugin-backends.ts:210), so it can't be triggered today.
  - It is a test seam in a money path, approved by the trim ("injected through the function's arguments"). Leave it, but never forward caller options into `sendMessage` from the host.
- Complexity: per report.md and by spot reading, `receipt` = 10 and `authorize` = 8 with nesting 3. At the limit, not over.
- Secrets: failures are fixed-text `"WhatsApp delivery <code>"` (:162-163); no token, credential JSON or phone number is echoed. No credential caching (one access per call, :67).
- Vendor names in core: none (plugin-local).

Duplicates (vs published Jini rc.2 / Tovu): none. rc.2 dist has no WhatsApp, template, pricing or prefix mechanism; Tovu has only i18n strings (per the review's search, consistent with the job's report). Twilio's ABI is mirrored, not imported (plugins never import each other).

Disputes/deferrals:
- Free-form/24 h window, media/header/button params, broadcasts, billed-price reconciliation and the server WhatsApp test (CUT 2): DEFERRED-OK.
- Intent→plugin category gap (OWNER DECISION 3): DEFERRED-OK, queued for a w15-backends job. It also applies to SMS.
- Numeric rates: DEFERRED-OK. They fail closed until the owner supplies Meta's USD CSV.

Typecheck: PASS (plugin, rerun). A server typecheck was correctly skipped, since there are no server edits.

Net lines: +426 / −124 = +302 (source/data +106, tests +157, docs/evidence +39).

Small fixes:
1. (Recommended, before any `usdRates` rows land) wa/src/rates.ts:21: remove `"1": "North America"` so that unmapped NANP numbers fall to the max-rate path, and update the matching prefix expectation in wa/tests/broadcast.test.ts.
2. Coordinator: rebuild the whatsapp plugin dist/digest (existing NEEDS). The owner must supply the Meta USD CSV before sends can work.
