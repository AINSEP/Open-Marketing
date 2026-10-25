---
name: twilio-sms
description: Inspect a connected Twilio account, sender and registration through OM's server tools.
---
Use om_twilio_account_status with the connectionId; use om_twilio_sender_status with connectionId and resource (service, number, brand, campaign or toll_free).
Number reads check the configured sender's membership and capabilities. Report vendor states literally; permission_limited and missing registration never mean ready.
Credentials are pasted in the server-owned credential card, never in chat or tool arguments. All calls use OM's ONE server policy; disabled/unadmitted means zero vendor network.
R1 cannot estimate, send or process delivery/opt-out events. Explain the missing integration instead of calling another vendor tool or bypassing OM with raw MCP/HTTP.
For future sends: only OM contacts with current explicit SMS-marketing consent; dispatch rechecks consent, suppression, erasure and recipient-local quiet hours. Missing policy/timezone defers sending.
STOP withdraws consent; HELP never grants it; record START without clearing withdrawals until the policy owner resolves reactivation. Do not duplicate Twilio keyword replies.
Every send is an external write with existing authority and ONE outbox; bulk uses one grouped exact card, at most 100 frozen recipients. Allowance accounting is not approval; unknown cost requires explicit spend approval.
