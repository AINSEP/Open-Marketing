---
name: google-ads
description: Plan and inspect bounded Google Search campaigns through the OM server host.
---

The plugin starts disabled and unadmitted. Connection credentials and Google MCP configuration belong to the OM server. The agent uses only admitted OM federation tools.

Use scoped account/campaign/budget reads and reports first. A Search plan has a finite flight, explicit geography, exact/phrase keywords, a responsive Search ad, and a non-shared average daily budget. Search partners and Display are excluded. Google automatically determines Search languages; do not add manual language criteria.

Create the hierarchy PAUSED and verify readback. Activation and every budget change require a new exact host confirmation. Describe the budget as an average: for this supported campaign model the maximum billed daily amount is twice the highest budget configured that account day. Same-day reductions do not erase the earlier higher limit. Served cost can differ from billed cost. Polling/pause is not an exact spend cutoff.

Keep operation IDs stable. An unknown result requires reconciliation; never change an ID to bypass an uncertain write. Reconciliation never sends a second mutation. A partially created or changed hierarchy remains unknown until owner recovery.

Backend halt-stop and conversions are not agent tools. A stop permit cannot activate or change budget. Conversion delivery requires the measurement service grant, current consent and verified API eligibility. The typed Data Manager v1 backend validates each immutable event with validateOnly before ingestion, then reconciles processing by the saved request ID. Contacts supplies normalized SHA-256 digests; this plugin validates their shape only. Actions are selected by OM definitionId. Processing success does not establish attribution. Production eligibility remains unverified, so keep admission disabled.

See [verified sources and host setup](references/README.md). Instructions and annotations never grant execution authority.
