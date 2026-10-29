Software Architect(Direct): Persona loaded. PLAN ONLY; no files changed or checks run.

**1. Summary**

Extend the WhatsApp plugin to use the existing owner-only `om_message_send` path. The owner will approve the recipient, template name, variables and maximum USD cost on the existing Allow/Cancel card. Before submission, the plugin will verify template approval and calculate a conservative price from Meta’s published rates. Current numeric rates remain unverified, so pricing evidence is a blocking input to send activation.

**2. Files**

Paths below are the complete proposed build scope.

- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/broadcast.ts` — (edit) replace the unused broadcast entry with host-compatible sending, template verification and quoted authority.
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/index.ts` — (edit) expose the send entry, channel, schemas and inferred types; remove superseded broadcast exports.
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/rates.ts` — (new) dated Meta rate data, country-to-market mapping and pure quote calculation.
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/tests/broadcast.test.ts` — (edit) migrate existing assertions and add approval/pricing regressions.
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/tests/fixtures.ts` — (edit) provide template/account GET fixtures and capture quotes separately from POSTs.
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/evidence/primary-sources.json` — (edit) record verified sources, rate dates and remaining limitations.
- `content/agent-plugins/whatsapp-business/README.md` — (edit) document the supported send shape and activation requirements.
- `content/agent-plugins/whatsapp-business/skills/whatsapp-business/SKILL.md` — (edit) direct the assistant through `om_message_send`.
- `apps/server/tests/message-send.test.ts` — (edit) prove WhatsApp channel consent, card contents and STOP-after-card refusal.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/progress.md` — (new) short implementation checkpoint record.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/report.md` — (new) handoff, deferrals and actual line counts.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/typecheck.txt` — (edit) capture permitted typecheck outcomes.

**3. Public contracts**

```ts
messageChannel = "whatsapp" as const
sendMessage(required: WhatsAppMessage & { dependencies: WhatsAppMessageDependencies },
            optional?: CallOptions): Promise<Outcome<WhatsAppDeliveryReceipt>>
```

- `WhatsAppMessage`, derived from `whatsappMessageSchema`: `{ context, deliveryId, recipient, message: { template: { name, language, bodyParameters } } }`.
- Preserve `whatsappDeliveryReceiptSchema` and its inferred accepted/unknown receipt type.
- Dependencies reuse existing configuration, credentials, fetch, clock and observer; accept the host’s `deadlineSignal` and `authority({ quote, argumentsDigest, execute })`.
- Existing command: `om tools call om_message_send --input-file message.json`. No new host command, capability or shared contract.

**4. Approach**

1. Replace `deliverWhatsAppBroadcastRecipient` in place. Its only callers are local tests; remove unused `definitionId` and `subjectId`, without a compatibility wrapper.
2. Parse the existing server configuration envelope and strict message schema. Reject free-form input and nested connection/credential fields before I/O.
3. Access credentials once per call. Preserve scope, WABA, phone-ID and expiry checks; retain no tokens between calls.
4. Read the bound WABA’s currency and query `/{wabaId}/message_templates` filtered by name/language. Require one exact match with `status: "APPROVED"` and a recognized category. Bound the response to 100 rows; refuse incomplete/ambiguous results instead of adding pagination.
5. Determine recipient country with `libphonenumber-js/max`; apply Meta’s documented market mapping. Use verified USD list rates for the observed category, conservatively covering authentication-international pricing where applicable. Unknown country, rate or currency refuses before reservation.
6. Keep decimal conversion in contracts’ `decimalToMicros`. Calculate in integer micros, then round upward into the existing host quote’s USD cents. Bind the quote to the frozen POST digest and dated pricing evidence.
7. Call the existing authority callback. Recheck expiry/cancellation before its single-shot POST. Preserve accepted versus unknown handling; never retry an ambiguous submission.
8. Write regressions for unapproved/missing/wrong-language templates, malformed evidence, country/category pricing, rounding, non-USD refusal, authority denial, credential redaction and accepted/unknown outcomes. Extend the server fixture to prove WhatsApp consent and STOP handling through the existing card-answer path.
9. Run only `corepack pnpm --dir content/agent-plugins/whatsapp-business typecheck` and `corepack pnpm --filter @open-marketing/server typecheck`, once each, with one corrective rerun allowed. Tests remain written, not run.

**5. Reuse**

- Host approval, channel dispatch, subject lane, outbox and accounting: `apps/server/src/composition/agent-plugin-backends.ts:162–237`. Channel dispatch already generalizes; no host source edit.
- WhatsApp POST, single-shot execution, receipt parsing and redacted failures: existing `src/broadcast.ts`; credential parsing and bounded reads: existing `src/transport.ts`.
- Quote shape: contracts’ `generationCostQuoteSchema` subset, following the existing Twilio send ABI; no cross-plugin import or copied pricing transport.
- Phone parsing: `libphonenumber-js@1.13.12`, already installed and used by `features/contacts/src/normalize.ts`. Import the library directly; plugins cannot import contacts.
- Searched Jini’s `CAPABILITIES.md`, Jini packages, and Tovu apps/packages/content for WhatsApp, template, pricing and phone-country mechanisms. No suitable implementation found. Installed Jini `0.6.15-rc.2` bounded-fetch APIs were inspected; existing OM transport helpers suffice here.
- npm registry/package pages were attempted but inaccessible. Reject a vendor SDK, live pricing scraper and a second messaging framework.

**6. Deliberately left out**

- Free-form sends: no trustworthy persisted 24-hour-window evidence exists in this lane.
- Template creation, media/header/button parameters, named variables, broadcasts and scheduling: outside the existing text-body send scope.
- Dedicated Studio composer, billing reconciliation, FX and automatic rate updates: separate work.
- New ports, factories, registries, approval rules and queues: existing mechanisms cover this job.

**7. NEEDS**

- **BLOCKING EVIDENCE:** Obtain Meta’s current USD rate card and country-to-market mapping, including effective date and authentication-international rules. Populate production rates only from verified primary evidence; otherwise report pricing/send activation DEFERRED.
- **COORDINATOR DEPENDENCY:** Add exact `libphonenumber-js@1.13.12` to `content/agent-plugins/whatsapp-business/package.json` and reconcile `pnpm-lock.yaml` before implementation typechecks. No lane install.
- **COORDINATOR INTEGRATION:** Rebuild WhatsApp plugin dist and refresh bundle integrity/digest after review.
- Shared-contract changes and migrations: none. Production enablement remains a separate owner decision.

**8. Unverified facts and risks**

- Meta confirms delivered-message pricing by market/category, but its linked numeric rate-card documentation returned login/429 responses. No current machine-readable rate source was verified; the proposed fallback is a plugin-local, dated table. Missing verified entries must refuse sending. [Meta pricing](https://whatsappbusiness.com/products/platform-pricing/), [rate-card documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
- Meta’s official SDK 26.0.2 confirms WABA currency and the template GET endpoint/status enumeration. Real-account permissions and responses remain untested; missing or unexpected fields fail closed. [Meta SDK 26.0.2](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/whatsappbusinessaccount.py).
- Local rates require maintenance when Meta changes prices. Template/category changes between verification and submission remain a vendor race; do not represent fixture coverage as live-account evidence.

**9. Size estimate**

One build, approximately 75–90 minutes after blocking inputs land. Twelve files: three source/data, three test/fixture, three documentation/evidence and three job records. Roughly +200/−70 source/data LOC and +180/−60 test LOC, net +250 code/data LOC; report actual totals.