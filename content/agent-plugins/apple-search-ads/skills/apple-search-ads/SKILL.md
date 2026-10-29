---
name: apple-search-ads
description: Discover Apple Ads ad accounts and query campaign pages through OM server tools; reporting is unavailable.
---
Use only server-admitted tools; the v1 plugin remains disabled pending host integration. Connect through server-sealed token custody; never ask for secrets in chat.
Select a discovered **ad account** (`adAccount.id`), not its organization. Require explicit reselection of legacy organization bindings; never guess an ad-account ID.
`list_accounts` returns ad-account identities/roles; `list_campaigns` returns bounded pages, never account completeness. No report tool or canonical capabilities are available; do not claim metrics support or invent zero spend, dates, watermarks or freshness.
PAUSED App Store install deployment uses the server's exact card and single jobs outbox. Verify each parent before children; never activate, retry unknown creates, roll back or continue partial launches. Reconcile saved IDs with GETs only.
Server origin/account binding, launch-objective compatibility and production metadata resolution remain NEEDS. If unavailable, explain the missing integration/admission; never call Apple directly.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Apple suggests four search-results campaign themes: brand, category,
  competitor and discovery. Review their fit for the app and market;
  this is a planning suggestion, never a required campaign count.
- OM's current launch tool creates only what its catalog entry allows; a four-campaign structure is a plan to review, not something OM will build automatically.
- Keep each theme's app, market and intended outcome explicit when reviewing
  supplied account evidence; do not infer an executable launch from this outline.

### Targeting

- Apple's suggested brand, category and competitor setup uses exact-match
  keywords with Search Match off.
- For discovery, Apple suggests a broad-match group with Search Match off,
  plus a Search Match group with no keywords. It also suggests adding the other themes' keywords
  as exact-match negatives in discovery to keep those exact queries separate.
- Review observed search terms before proposing keyword moves; record which
  theme a query serves and the overlap the proposed change would address.
  Check current Apple Ads docs for eligibility and available targeting options.

### Creative

- Review whether the store listing actually demonstrates the app benefit
  promised to the searcher. Flag a mismatch between keyword intent and the
  screenshots, description or experience the owner supplies for review.
- Tie creative proposals to that app and market. Do not promise a listing
  change, asset upload or placement that OM's catalog does not expose.

### Budget/bidding

- Explain how proposed funding balances finding useful queries with supporting
  themes that already show downstream value in supplied evidence.
- Consider acquisition cost, post-install outcomes and observed volume together
  before proposing a bid change. Check current Apple Ads docs for bid modes
  and budget rules; invent no minimum or automatic scaling threshold.

### Measurement pitfalls

- Compare installs with the owner's downstream app outcomes before describing
  a theme as valuable; a cheap install alone does not establish customer value.
- Keep Apple account evidence and app analytics sources identifiable. Explain
  mismatched windows or missing detail before comparing their totals.
- OM reporting remains unavailable as described above; request supplied
  evidence for review and leave unsupported performance conclusions pending.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
