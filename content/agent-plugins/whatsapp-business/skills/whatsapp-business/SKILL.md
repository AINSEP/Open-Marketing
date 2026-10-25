---
name: whatsapp-business
description: Inspect WhatsApp Business account verification, sender quality and template approval status through OM.
---

Use `get_account_status`, `list_senders`, or `list_templates` through OM's server.
Example: “Show my WhatsApp sender quality and approved marketing templates.”
For lists, request at most 100 rows; use returned cursors only when another page
is needed. Explain absent verification/name/quality/tier values as unknown.
Business verification and messaging limits remain vendor-controlled restrictions.

Connection setup reuses Meta sign-in or a sealed system-user token plus WABA ID
and phone-number ID. Never accept credentials, raw phone destinations or arbitrary
URLs as tool arguments. Non-admission means zero network, including refresh.

Sending, estimates and delivery webhooks are deferred in R1. Do not claim a
message was sent. Future sends need consent-filtered OM contacts, current SMS
marketing consent plus WhatsApp opt-in, quiet hours and a dispatch-time recheck.
Every send is an external write under the ONE policy and ONE outbox. Approved
templates are required outside the 24-hour service window. Unknown prices need
explicit spend approval; never estimate zero or treat WhatsApp as SMS segments.
STOP/explicit opt-out must withdraw consent. Ambiguous outcomes must not resend.
