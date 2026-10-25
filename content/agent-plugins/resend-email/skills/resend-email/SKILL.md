---
name: resend-email
description: Read Resend domain status and DNS records through admitted OM tools and secure host authentication.
---

Use only admitted OM tools. R1F declares domain_status only; server wiring is pending. Sending, batch/segment handoff and feedback are deferred. Never call Resend directly or use hosted MCP as a bypass.
Connect using the secure paste-token card: create a Full access key at https://resend.com/api-keys and paste it into the form, never chat or tool arguments. Reuse the existing connection. Sending-only permission cannot read domains.
Read one bounded domain page or a domain detail. Show DNS records for setup in Resend; this plugin cannot change DNS or tracking settings. Domain status and tracking flags are observations and never authorize sending. Missing flags or unknown states cannot establish readiness.
Permission failures need a Full access key. Missing host binding, deadlines and unverified vendor behavior mean unavailable; do not invent a successful probe or provider fact. Never print provider error bodies or credentials. Sending requires a separately approved implementation and the existing server policy/outbox/consent integrations.
