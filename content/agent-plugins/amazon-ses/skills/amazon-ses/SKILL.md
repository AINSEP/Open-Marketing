---
name: amazon-ses
description: Check SES account/domain status and use the host-integrated Jini provider for approved recipient delivery.
---

Use OM server tools account_status and domain_identity_status after connection/admission. R2 adds a Jini mail provider for server composition; it does not add an assistant send tool. Never bypass missing server wiring with raw AWS calls.
IAM user access keys and region go into the server credential card, never chat/tool arguments; no root/SMTP keys. Sending additionally requires ses:SendEmail on the configured domain identity. Account setup, DNS and regional production access are manual.
Quota, sandbox, plan and DKIM status are observations, never spend authority or consent. Keep tracking off.
For an integrated send, freeze approved recipients/content and use the ONE policy/outbox. The required authority callback must recheck current marketing consent, suppression/erasure, grant/caps and paid-send authority at dispatch while holding the subject lane. Never impersonate the owner for service-worker accounting.
Bulk requires a working HTTPS unsubscribe footer and exact one-click headers. Attachments are unsupported. Safe custom headers, including X-Original-To for test redirects, are accepted; duplicate casing and reserved address/MIME headers are refused. A safe HTTPS unsubscribe URI may appear alongside mailto. Jini's registry, purpose gate, delivery policy and limiter are host-composed, not copied into this plugin.
SES has no send idempotency token. Persist delivery identity/receipts in the server ledger and set Jini resendPolicy to never. Unknown outcomes require reconciliation without resubmission. Accepted does not mean delivered.
Feedback requires a configured identity SNS topic and a TLS-validating injected fetch; configuration-set eventType payloads and automatic subscription confirmation are unsupported. Await provider.prepareFeedback({ rawBody }, { signal }) before Jini ingest; it validates the regional SNS certificate URL/topic, fetches with redirects rejected and caches one certificate until expiry or one hour. On fetch failure, return a retryable failure without ingest. The existing verifier authenticates the signature before durable dedup/suppression. Missing/expired certificates never permit suppression writes or signature bypass.
Missing dependencies, server routes, durable stores, cost/consent authority or working unsubscribe endpoint keep sending unavailable. Fixtures do not establish real-account readiness.
