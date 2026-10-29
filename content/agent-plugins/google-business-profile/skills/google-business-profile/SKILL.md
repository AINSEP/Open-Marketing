---
name: google-business-profile
description: Read locations and daily performance, and publish owner-approved text Updates to a connected Google Business Profile.
---

Use `list_locations` to inspect one page in the connected Google account. Pass the
returned `nextPageToken` explicitly to continue. The server selects the account
and reporting location; tool arguments cannot switch either binding.

Use `read_performance` with calendar dates `{days: {start, end}}`, start inclusive
and end exclusive, at most 366 days. In fixture mode use 2026-09-30 to 2026-10-01.
Report call-button clicks, website-link clicks, direction requests and profile
impressions with their actual meanings. Call clicks are not answered/completed
calls or verified leads. Impressions are not deduplicated reach. A null is missing
data; an explicit zero is observed zero. Never infer spend or conversions.

No canonical `report.metrics.v1` capability is served yet; a verified timezone
source is pending. Use `read_performance` for native daily counts. Native reads
need no reporting metadata.

On unauthenticated, reconnect through the server-owned OAuth flow. On forbidden,
check Google Cloud project approval, API enablement and the user's profile access.
Never ask for tokens in chat. This plugin adds no approval rule.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval. Publish only text Updates through the catalog tool below; review replies, Offers and Events remain owner-facing drafts.

### Listing accuracy

- Google says complete, accurate business information helps a profile appear
  in relevant local results. Review the supplied address, business description
  and regular/special hours against what customers can actually expect.
- Flag mismatches between the profile and the owner's current business facts;
  propose corrections for owner review without claiming OM changed the listing.

### Local relevance

- Describe the services and customer needs this location actually serves.
  Keep locality references truthful; do not invent a location or service area
  to make a profile appear relevant to more searches.
- Google says better local ranking cannot be requested or bought. Promise no
  rank, visibility gain or guaranteed enquiries from a profile change.

### Posts

- Draft Updates for news, Offers for promotions and Events for dated occasions.
  Include an offer title and dates/times; for events include a title plus start
  and end dates/times. Check the actual availability before drafting the offer.
- Keep the post's destination consistent with its purpose. Google may reject
  a phone number in the description if it cannot verify the business connection.
  Use the approved publish flow below for a text Update. Hand other drafts to the owner; do not claim publication or scheduling.

### Reviews

- Draft brief, professional, helpful replies that acknowledge the specific
  experience. Replies are public: disclose no reviewer private information,
  avoid promotional pitches and do not repeat identical thank-you replies.
- Invite genuine reviews through the owner's Google review link or QR code.
  Google prohibits incentives for posting, changing or removing reviews;
  never offer a reward to obtain a favourable review or erase criticism.

### Measurement pitfalls

- Use the read meanings above when discussing profile activity. A draft post
  or reply is not evidence that the owner published it or gained an enquiry.
- Compare supplied profile and business-outcome evidence for the same location
  and period. Leave unanswered calls, completed visits and lead quality unknown
  unless the owner provides evidence; promise no ranking effect from activity.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)

## Publish a text Update

When the server catalog makes `vendor_google_business_profile_organic_publish_v1`
available, supply one operationId, the connected connectionId, the bound accountId
(`accounts/{a}/locations/{l}`), and `arguments: { text, languageCode? }`. Keep text
within 1,500 characters. The owner approves the exact location and text on a fresh
server card for each call. Never reuse approval or substitute another location.
Report `published`, `processing` or `rejected` as returned. For `unknown`, check
the profile, never re-post. No media, CTA, Offer/Event, scheduling or review reply
is implemented. Publishing stays unavailable while server mode is read-only or
the plugin/capability is unadmitted.
