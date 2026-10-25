---
name: kakao-ads
description: List Kakao Moment accounts/campaigns and request daily BASIC reports through OM server tools.
---
Use the server's Kakao tools once the integrator exposes this plugin. Examples: “List my Kakao ad accounts”, “Show Kakao campaigns”, “Report Kakao performance for October 1–7”.
Connect a pasted Business token with moment_management using the existing Integrations flow. Never request secrets in chat or call Kakao directly from the agent.
Use list_accounts with optional zero-based page; list_campaigns with optional ON/OFF config; report with inclusive start/end yyyyMMdd, <=31 days, strictly before today in KST.
BASIC is not Message reporting. Missing metrics remain unavailable; config is not proof an ad is serving. Do not sum or invent absent metrics, billing currency or UTC timestamps.
Account discovery needs an owned connection; campaigns/reports also need a bound account. Admission and current authority are enforced by the server's one policy. Report throttling and require reconnection on token failures; do not poll or retry automatically.
Creation, deployment, activation, budget changes, conversions and OAuth are unsupported. Explain that safe PAUSED/DRAFT creation is still unverified; never create then pause as a workaround.
