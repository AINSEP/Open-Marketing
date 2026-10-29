---
name: amazon-ads
description: Browse Amazon Ads profiles/campaigns and request bounded SP/SB reports through OM, with platform-specific campaign planning/review guidance.
---
Use installed OM tools only; credentials, vendor HTTP and configuration stay server-owned.
List profiles, select a connected profile, then list SP or SB campaigns one page at a time.
Request spCampaigns for traffic/cost or sbPurchasedProduct for purchased-product metrics.
Report creation uses the existing normal write grant; get/download use read policy.
Pass inclusive ISO dates, at most 31 days. Check status separately; never create a polling worker.
Download by report ID only. Never ask for, return or accept a signed report URL.
Owner sign-in/reconnection is unavailable until server-owned OAuth/refresh with an HTTPS callback is integrated.
Explain that setup is pending; never ask the owner to paste a short-lived token or calculate an epoch expiry.
Unknown report requests must reconcile read-only; do not automatically resend them.
Deployment, activation, conversions and OAuth sign-in are unavailable in R1.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Keep marketplace/profile and product-family ownership explicit in the plan.
  Review Sponsored Products separately from other ad products.
- Group closely related ASINs from the same category; separate products whose
  margins, stock or price ranges call for different budgets and bids.

### Targeting

- Use automatic targeting for discovery: close match, loose match, substitutes
  and complements address different shopping contexts.
- Use manual keyword or product targeting for deliberate coverage. Review
  search-term evidence before proposing targets or negative keywords/products;
  an irrelevant product pairing is a clearer exclusion than a quiet query alone.

### Creative

- For Sponsored Products, review the advertised listing and destination detail
  page: stock, featured-offer eligibility, title, images and product information.
- Keep the advertised ASIN and variation consistent with the shopper's landing
  experience. Check current Amazon Ads docs for the selected format's specs;
  do not apply listing-image guidance to every ad product.

### Budget/bidding

- Relate proposed bids and budgets to product margin and inventory, including
  the effect of placement adjustments on the possible bid.
- Review dynamic bids up and down, dynamic bids down only, or fixed bids against
  that product's economics. No strategy warrants an automatic budget increase.

### Measurement pitfalls

- Keep ad-attributed sales, total retail sales, ACOS and TACOS distinct. Request
  missing retail totals rather than inferring them from campaign reports.
- Check product mix, stock and price changes before attributing performance
  shifts to targeting. Compare reports within the same profile/marketplace and
  compatible reporting windows; unfinished reports cannot establish a result.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
