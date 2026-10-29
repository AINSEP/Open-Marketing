---
name: linkedin-ads
description: Inspect LinkedIn ad accounts and prepare non-serving LinkedIn campaigns and creatives through Open Marketing's server tools. Activate and change budgets only through exact spend cards.
---

# LinkedIn Ads

Use only the OM server's installed LinkedIn tool catalog. Credentials, vendor configuration and direct vendor HTTP belong to the server-loaded plugin; never request or expose tokens in chat or agent configuration.

1. Inspect accounts, groups, campaigns or creatives with `list_accounts`, `list_campaign_groups`, `list_campaigns`, `list_creatives`. Each accepts optional IDs and bounded pages. Use the returned token for another explicit call; never follow a provider URL.
2. `search_targeting` discovers locations/profileLocations/industries/employers/skills/titles. Campaign targeting accepts explicit geo IDs only.
3. Create a campaign group with `create_campaign_group_draft`. DRAFT is the documented non-serving creation status; never create ACTIVE and then pause.
4. `create_campaign_paused` creates Sponsored Content with an existing group, organization, locale, geo IDs, decimal daily budget/bid, schedule and politicalIntent. Obtain the advertiser's declaration and present the vendor's EU notice where applicable. `create_creative_paused` references an existing share or ugcPost under the campaign. Creation forces PAUSED; unsupported inputs reject.
5. `activate` affects ONE group/campaign/creative, and `set_budget` affects ONE campaign. EVERY call uses a fresh exact server spend card. No budget envelope, reallocation authority or Always allow for ad spend. Normal writes use the same general server approval rule.
6. `pause` is a normal campaign write. For halt, use OM's general halt action: the server's typed stop backend can issue only PAUSED campaign patches after local halt. The plugin does not expose a halt permit as an assistant tool.

7. Use `report` for account or explicit campaign analytics. Supply a half-open UTC-midnight window (maximum 366 days); campaign pivot needs unique campaign IDs. Results preserve decimal spend and source/retrieval time. Empty means no data/access unconfirmed, not zero spend. Older provider windows rounded to months reject; narrow the period or request full months explicitly.
The server may call the declared read-only `report.metrics.v1` (daily metrics) and `campaign.status.v1` capabilities; they are not assistant tools and add no write or spend authority.

8. Inspect `list_conversion_rules` before selecting a rule. `create_conversion_rule` prepares a CONVERSIONS_API rule with explicit name/type/attribution windows/model and optional OBJECTIVE_BASED or ALL_CAMPAIGNS auto-association. `associate_conversion_rule` links one rule to one campaign. These use normal server write authority and do not activate anything. Confirm IDs and account ownership; an ACK does not prove attribution.
9. `list_lead_forms` lists account-owned form metadata only, with bounded count/start. A nextStart hint needs a new explicit call. Never follow provider links or request lead downloads.

Pass each tool's literal `kind` in its command arguments. Server composition supplies the account/connection binding, operation identity and canonical exposure/limit metadata. Reuse server operation identity for reconciliation; never blindly resend an unknown write. A campaign/creative ACK or update ACK is not observed serving state. Group create ACK format is UNVERIFIED and remains unknown; use a separate account-bound list readback. Missing admission/access returns a typed denial, not permission to invent a workaround.

Conversion events are delivered only by typed server measurement jobs under current consent/grants. There is no deliver/reconcile agent tool. Contacts alone supplies the unchanged lowercase SHA-256 email digest; never obtain raw identifiers in chat or hash them here. An unknown delivery must not be blindly retried. There is no lead-response download, media upload, destructive tool, generic HTTP or organic publishing in this plugin.

API version 202610 and enriched creative reads were checked 2026-10-24; earlier endpoint evidence retains 2026-10-13 dates. Official links and field/scope evidence live in ../../README.md and the OM namespace's evidence/primary-sources.json. Fixtures are synthetic and do not establish live vendor eligibility.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Connect the campaign's business outcome to the intended buying role and offer;
  distinguish awareness, enquiry and a sales-qualified opportunity in the plan.
- Review the campaign group's purpose and the relevance of each existing
  share or post before treating a professional audience as a single buying intent.

### Targeting

- LinkedIn requires location. Job title, seniority, company size and skills
  can inform audience planning/review; the OM create tool takes geo IDs only.
- Search results do not mean those professional facets will be applied by OM.
  LinkedIn's minimum audience to run an ad set is 300 member accounts;
  that is an eligibility minimum, not a recommended audience size or proof of demand.

### Creative

- Review whether the existing post's offer fits the intended professional role:
  an end user's problem may differ from a budget owner's buying question.
- Make the promised next step clear before asking for an enquiry.
  Check current LinkedIn docs for the selected format's media specifications.

### Budget/bidding

- Assess budget viability against the reachable buying audience and desired
  lead quality; a cheap form submission alone does not justify more allocation.
- Check current LinkedIn docs for bidding options. Use account-specific outcome
  evidence rather than a universal cost-per-click target or budget rule.

### Measurement pitfalls

- Review form submissions alongside advertiser-supplied qualification and sales
  outcomes; a submitted form does not establish purchase intent or revenue.
- Separate audience-fit evidence from conversion setup evidence. Missing lead
  quality data leaves that question open; it does not establish campaign success.

Use om-playbook's strategy-and-brief for briefs, ad-copy-variants for copy field limits, creative-test-plan and creative-fatigue-review for creative methods, analytics-attribution-basics for attribution, and landing-page-cro for destination/message consistency.

[Provenance](PROVENANCE.md)
