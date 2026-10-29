# Twilio SMS — R2 recipient delivery

The public entry retains the read adapter and exports `sendMessage`, `messageChannel`, `ingestWebhook`, request/receipt/webhook schemas and inferred types. They are plain server-loaded plugin functions with injected dependencies. There is no SMS engine, queue, audience resolver, scheduler or plugin approval switch. The plugin remains disabled/unadmitted; existing read tools are the only advertised capabilities.

```ts
await sendMessage({ context, deliveryId, recipient, message: { content }, dependencies }, { signal });
const result = await ingestWebhook({ dependencies, rawBody, headers, path }, { signal });
```

Sending resolves the server binding and call-local API-key credential, then free Basic Lookup and Pricing evidence. The quote uses the largest carrier/number-type USD rate, conservative UCS-2 segments (66 units per part, graphemes never split), cent rounding and 1¢/segment carrier headroom. The authority callback receives `{ quote, argumentsDigest, execute }`; the host owns the exact Allow/Cancel card, current SMS consent/STOP suppression under its subject lane, durable dedup, paid-send reserve/settle and audit. Denied authority means no Messages POST. Accepted sends settle provisionally at the quoted upper bound; billed-price corrections are deferred.

One Messages POST uses the configured MessagingServiceSid, E.164 To, bounded Body (no status callback); no sender provisioning/MMS/scheduling. Unknown registration fails closed. A second execute call cannot submit again. Requests <=64KiB, streamed responses <=64KiB, deadline <=10s through body consumption, redirects rejected, zero retries. Broker, fetch, deadline, clock and observer are injected. API-key secrets stay in the server plugin.

A valid vendor SID yields `accepted`, not handset delivery. Timeout/cancellation after submission, transport errors, malformed success and ambiguous HTTP responses yield `unknown`; the host must reconcile without blind resend. Twilio is not assumed to deduplicate sends. [Messages API](https://www.twilio.com/docs/messaging/api/message-resource).

The host mounts `POST /hooks/agent-plugins/:pluginId/:connectionId/:accountId`. `ingestWebhook` parses the standard server configuration and fetches the credential card afresh for each call. Add the account Auth Token and optional non-secret `webhookUrl` to that card. The URL must be HTTPS, have no query/fragment/user info, and match the callback path exactly; it is never reconstructed from Host or forwarded headers. AccountSid must match the bound account. If the credential contains MessagingServiceSid, the callback must contain that exact SID. Optional install setting `sender` restricts non-service callbacks to the incoming To/outgoing From. No sender is required for account-bound callbacks.

Existing HMAC-SHA1 verification covers the exact configured URL and every sorted decoded form field; repeated keys and foreign assets fail. The generic entry returns `{ events }` with channel `sms`, without an apply callback or raw message text. Authenticated STOP/Advanced Opt-Out produces withdrawals; START/HELP never restore consent. The host resolves known contacts and durably appends suppression, treating STOP replays as already applied. Unknown contacts are acknowledged. Delivery events are acknowledged and discarded until sending is hosted. Success is an empty 204 response. The host byte limit is 128KiB; the plugin retains its 256KiB/100-parameter cap.

NEEDS: deployment must preserve original callback bytes and rewrite Host for the loopback listener without weakening its Origin checks; refresh bundle/digest after the credential-card change. Owner-started sends use `om_message_send`; local production mode remains read-only. Broadcasts/ServiceGrant, Studio composer/callback display and billed-price reconciliation remain deferred. The plugin remains disabled/unadmitted until separately configured. Tests are written, not run; no live delivery/spend is proven.

HTTP 429 is definitive retryable `limit_exceeded` back-pressure. `om_message_send` records it as `failed` with zero settlement and no host deferral; the owner re-asks. The provider performs no internal retry. Failed/oversized success-body reads remain unknown. The response reader is reused from the existing transport.
