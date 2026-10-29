---
name: microsoft-ads
description: List Microsoft Advertising accounts and Search campaigns and request daily performance through existing OM tools, with platform-specific campaign planning/review guidance.
---
Use the existing OM agent-plugin discovery/execute routes for list_accounts, list_campaigns and report. These are read effects under the ONE server policy. The plugin stays disabled/unadmitted until host integration and connection setup.
Never request tokens in chat or tool arguments. The server stores the OAuth access token and, through the plugin-secret "Save developer token" card, the developer token; the host attaches it to the bound connection as secrets.developerToken. OAuth requires a configured confidential-web client, S256 PKCE and OM's exact registered callback; use paste-token until available.
Reports use half-open UTC midnight windows, up to 366 days, and preserve scalar decimal strings. Distinguish reported zeros, no_data, expired polling and failures. Account discovery is paged; campaign listing covers Search only. Respect pageLimitReached; never infer missing totals or serving status.
Campaign writes, activation and conversions are unavailable in R1. No direct vendor calls, custom policy or plugin-specific approval flow.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Organize Search campaigns around intent, geography and business ownership;
  keep ad groups focused on related queries and destinations.
- After a Google Ads import, review effective settings and import errors rather
  than assuming equivalence. Include campaign status, location mapping, network
  distribution and any scheduled imports in the review.

### Targeting

- Review search queries, match types and negative keywords together. Check that
  imported negative lists and associations still express the intended exclusions.
- Inspect Search network distribution before comparing traffic quality. A
  campaign imported from another platform is not proof of identical inventory;
  recommend network changes only from the account's actual evidence.

### Creative

- Review responsive-search headlines and descriptions as assets that may be
  combined for different queries; each combination should fit the destination.
- For RSA headline/description/path limits use the ad-copy-variants skill.
  Check current Microsoft Advertising docs for format eligibility; an imported
  campaign or a product label does not establish that every format is available.

### Budget/bidding

- Base bidding proposals on verified conversion evidence and the business's
  economics. Do not assume a strategy suitable elsewhere transfers unchanged.
- Inspect effective bids and budgets after import; import may adjust them.
  Check whether a scheduled re-import could overwrite a proposed change before
  handing it off. No universal budget minimum or cross-platform CPC target applies.

### Measurement pitfalls

- For website conversions, review UET installation and the intended conversion
  goals together; tag presence alone does not establish correct business events.
- Keep Microsoft reports separate from the source platform's totals. Review
  imported conversion settings, account timezone and Search network distribution
  before interpreting differences as a performance gain or loss.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
creative-test-plan and analytics-attribution-basics; RSA copy uses ad-copy-variants.

[Provenance](PROVENANCE.md)
