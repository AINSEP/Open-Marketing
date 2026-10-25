---
name: vk-ads
description: Read VK token-account identity and campaigns through server OM tools.
---

Use only admitted server tools: list_accounts, list_campaigns.
Connect with a sealed pasted token through the server connection flow;
never put tokens or client secrets in chat, tool arguments, logs or the agent runtime.
list_accounts identifies one token account. list_campaigns has explicit limit/offset.
Client issuance and refresh are unavailable until the existing broker supports
durable issuing/unknown state and reconciliation. No token POSTs occur in this adapter.
Statistics are unavailable until the official response envelope is captured.
Spend currency/units, timezone and campaign statistics ID mapping remain unverified.
Never infer zero spend, normalized money, PAUSED state or conversion attribution.
Admission defaults false. No creation, activation, budget edits, conversions or browser OAuth.
Host account onboarding, guarded policy egress, deadline, catalog and studio wiring remain integrator work.
