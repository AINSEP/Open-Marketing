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

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Map owner-supplied Moment evidence from ad account to campaign, ad group
  and creative. Review the campaign's selected objective and ad type together.
- Ad groups hold audience, device/placement, bidding, budget and schedule
  choices; connect those choices to the campaign goal before recommending edits.

### Targeting

- Distinguish the audience sources in supplied Korean account evidence;
  do not treat every group as reaching new customers.
- Kakao Pixel & SDK supports retargeting from website/app actions.
  Ask the owner for evidence of the linked source before describing that audience.

### Creative

- Review the Korean creative against the selected Moment ad type and placement;
  keep its offer consistent with the destination.
- Check current Kakao Moment docs for that format's creative requirements;
  this guidance supplies no dimensions, text limits or review-time promise.

### Budget/bidding

- Available bidding depends on the selected objective and ad type.
  Review that combination in owner-supplied settings before proposing a bid.
- Review the selected group budget and schedule alongside that goal;
  check current Kakao Moment docs for applicable budget and billing conditions.

### Measurement pitfalls

- Pixel & SDK also supports conversion tracking. Review owner-supplied Kakao
  linkage/event evidence when discussing a conversion-oriented campaign.
- OM's BASIC report does not establish conversions or Pixel & SDK setup.
  Keep conversion conclusions pending when the owner has supplied no such evidence.

For shared methods use strategy-and-brief, ad-copy-variants,
creative-test-plan and analytics-attribution-basics in om-playbook.

[Provenance](PROVENANCE.md)
