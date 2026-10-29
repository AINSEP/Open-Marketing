---
name: twilio-sms
description: Inspect Twilio account/sender status and use approved server recipient jobs with verified STOP feedback.
---

Use om_twilio_account_status or om_twilio_sender_status for admitted reads. R2 delivery/webhook exports are server integration modules; no new send tool is advertised. Never replace missing integration with raw vendor HTTP/MCP.
Store Account SID/API Key SID/secret and the optional Account Auth Token in the server form. Webhook verification separately uses the account Auth Token and exact public URL, not the API-key secret. Missing registration/status does not mean ready.
Once the host is integrated, freeze the approved broadcast definition/content and consent-filtered OM subjects, then enqueue one stable deliveryId per recipient in the ONE outbox. Every send rechecks current SMS consent, suppression/erasure, quiet hours, registration, grant/caps and paid-send authority under the shared subject lane. Unknown cost requires explicit spend authority; accounting is not approval.
No MMS, provisioning, vendor lists or local scheduler. Report accepted separately from delivered. Unknown outcomes reconcile without blind resend; no vendor dedup guarantee is assumed.
Verify every raw form webhook with Node crypto HMAC-SHA1 over the exact public URL and every sorted form parameter before state changes. No Twilio SDK is required. Authenticated STOP/opt-out records suppression atomically with replay dedup; START/HELP never remove withdrawn consent. Do not duplicate Twilio's keyword replies.
Missing host authority, durable stores, webhook binding or price/quiet-hour policy means unavailable. Fixtures do not prove live delivery or production serialization.
