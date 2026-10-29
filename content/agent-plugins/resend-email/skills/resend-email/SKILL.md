---
name: resend-email
description: Read Resend domains and use the server-integrated Jini mail provider for approved recipient delivery.
---

Use admitted OM server tools only. The public R2 provider is an integration module, not a new send tool; sending remains unavailable to the assistant until the server exposes the approved workflow. Never bypass it with raw HTTP/MCP.
Save one Full access API key in the secure credential form for domain reads and sending. Add the separate Svix signing secret in the optional webhookSecret field for feedback. Never put secrets in chat/tool arguments.
Domain/DNS status is an observation, not consent or send authority. Request DNS setup manually; this plugin does not write DNS or tracking configuration.
After server wiring: freeze approved content and recipients; enqueue one durable job per recipient under the ONE server policy. The required authority callback executes each send only after the server rechecks current consent, suppression/erasure, definition/grant/caps and paid-send authority under the subject lane. Normal writes use normal grants; this plugin creates no extra opt-in or approval switch.
Bulk needs a functioning HTTPS unsubscribe footer and exact List-Unsubscribe / List-Unsubscribe-Post one-click headers. Attachments are unsupported. Report provider acceptance separately from inbox delivery.
Stable delivery keys and receipts belong to the server ledger/outbox. Unknown submission outcomes require reconciliation, never blind resubmission; Jini resendPolicy must explicitly be never. Authenticate raw Svix feedback before durable dedup/suppression. START or later contact activity cannot silently restore withdrawn consent.
Missing server bindings, cost authority, Jini dependency, sender evidence or unsubscribe endpoint mean unavailable. Do not claim live delivery from fixtures.
