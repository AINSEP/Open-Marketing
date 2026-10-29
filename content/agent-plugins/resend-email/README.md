# Resend email — R2 provider adapter

The public entry exports the existing read-only adapter plus `createResendMailProvider({ clock, domainId, authority })`, request/event schemas and their inferred types. The new module implements the published `@jini-ai/platform/mail` 0.6.12 ABI. Construction is inert: no registration, settings, workers or vendor calls. There is no send tool/capability yet; the plugin stays disabled and unadmitted pending server integration.

The host registers/selects the provider using Jini's registry, then composes its purpose gate, delivery policy, lane limiter and feedback ingest. Set `resendPolicy: () => "never"` explicitly; Jini's default can reclaim unknown outcomes. All policy, storage, scheduling and audience resolution belong to the server. Tests show this composition with synthetic ports.

```ts
const provider = createResendMailProvider({ clock, domainId, authority });
const inner = provider.create({ credential: { token: fullAccessToken }, kit: { httpClient: guardedHttp } });
// Host wraps inner with Jini delivery policy and the purpose gate before using it.
await mailer.send({ message, workspaceId, idempotencyKey: deliveryId, sourceContext }, { purpose: "bulk" });
```

Save one **Full access** API key in the credential card. It serves domain reads and delivery; no second sending key or domain-read connection is needed. The optional `webhookSecret` field accepts the distinct Svix signing secret for bounce/complaint verification. Credentials never enter chat or tool arguments. [API key permissions](https://resend.com/docs/api-reference/api-keys/create-api-key).

Each delivery is one recipient/job and one POST to `https://api.resend.com/emails`. The stable idempotency key is passed unchanged. Resend retains keys for 24 hours, so durable OM dedup must outlive that window. An HTTP acceptance requires a validated provider message ID; missing/invalid receipts, transport failure and ambiguous statuses remain unknown. No automatic retry or fabricated receipt. Acceptance is not inbox delivery. [Send API](https://resend.com/docs/api-reference/emails/send-email), [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).

Bulk mail must contain the working server-owned HTTPS unsubscribe footer and a `List-Unsubscribe` URI list containing a safe HTTPS endpoint (optionally alongside `<mailto:…>`) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Header values cannot contain CR/LF and duplicate casing is rejected. Attachments are unsupported and explicitly refused. Input <=64KiB, response <=1MiB, webhook <=256KiB/100 recipients, timeout 10s, zero internal retries. The injected HTTP port must enforce response limits before buffering, reject redirects and honor the timeout through body consumption.

The required `authority({ input, execute }, options)` callback is the final server authority seam. `input` is the parsed, frozen delivery snapshot. The server rechecks current admission, subject binding, consent, suppression/erasure, grants/caps, paid-send authority and the exact payload, holding the subject lane through `await execute()`. Denial or a missing callback causes zero HTTP calls; repeated execution is refused. Exceptions after submission remain unknown. This plugin wires that callback; synthetic tests do not prove the server's consent/withdrawal race guarantee. Guarded HTTP still owns transport limits and correlated egress audit.

Domain methods perform one configured-domain read and map required DNS records/status without DNS writes. The existing read adapter still supports bounded list/detail reads. Domain evidence is never send authority.

Svix verification authenticates exact raw bytes with a five-minute window and rotating secrets. Jini feedback ingest owns durable inbox dedup and suppression: hard bounce blocks all mail; complaint blocks bulk. The host must bind endpoint/workspace/connection and apply feedback/withdrawals under the same subject lane. No fallback webhook ID or hidden clock is used. [Signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests).

NEEDS: integrator adds exact `@jini-ai/platform@0.6.12` dependency/lock resolution; registers providers and guarded HTTP in server composition; mounts raw webhooks and functioning HTTPS one-click unsubscribe (GET never withdraws); supplies durable ledger/inbox/suppression and outbox recipient jobs; closes HTTP/studio/CLI/catalog together. No live domain, DKIM, delivered headers, account or concurrency behavior is proven. No migrations or production admission here.

Tests in `tests/mail.test.ts` are written, not run. Both fixture transport modes exercise the same policy assertions; they are not production server adapters. No tests, builds, installs or om:check were run. See PROVENANCE.md and evidence/primary-sources.json.

HTTP 429 is definitive retryable `MAIL_RATE_LIMITED` back-pressure. Retry-After seconds or HTTP dates use the injected clock and are clamped to one day; invalid hints are omitted. The host defers the job; the provider performs no internal retry.
