# Platform limit sources

Verification snapshot: **2026-10-25**; Meta guidance verified by the **2026-10-26 re-review** from the placement guides cited below. The operational table and validation caveat live in [SKILL.md](../SKILL.md). Vendor facts below are paraphrased from primary documentation.

## Primary documentation

- [Google responsive search ads](https://support.google.com/google-ads/answer/7684791?hl=en): field maximums, asset counts and double-width counting verified. Assets can appear in different orders and can still be shortened in display.
- [Microsoft ResponsiveSearchAd](https://learn.microsoft.com/en-us/advertising/campaign-management-service/responsivesearchad?view=bingads-13): asset counts, final field lengths, double-width rules and combined domain/path lengths verified. The larger dynamic-text input allowance is not a final display allowance; this skill does not introduce substitution workflows.
- [Facebook feed image guide](https://www.facebook.com/business/ads-guide/update/image/facebook-feed): Recommended primary text: 50–150 characters; headline: 27 characters.
- [Instagram feed image guide](https://www.facebook.com/business/ads-guide/update/image/instagram-feed): Recommended primary text: 125 characters; headline: 40 characters. Maximum number of hashtags: 30.
- [LinkedIn single image specifications](https://www.linkedin.com/help/lms/answer/a426534): introductory text, headline and description maximums and visibility recommendations verified. Reject the adapted upstream table's obsolete introductory-text maximum. Audience Network description limits may vary.
- [TikTok auction in-feed specifications](https://ads.tiktok.com/resources/help/article/tiktok-auction-in-feed-ads?lang=en): non-Spark caption restrictions verified; this page does not state a caption character maximum. Do not infer that Spark caption display rules apply to non-Spark.
- [X creative specifications](https://help.x.com/en/business-and-advertising/creative-ad-specifications): text/image post-copy allowance and URL weighting verified. The image website-card section supplies no field lengths in the retrieved page; card title/description limits remain unknown. Website Carousel title guidance is a different format.

Meta character figures are text recommendations, not hard character limits. Description guidance and character maximums remain Unknown for both placements.

## Counting and plugin constraints

- Count spaces, punctuation and mandatory qualifications. Glyphs, Unicode code points, UTF-16 units and vendor-weighted lengths can differ.
- Google counts double-width language characters twice. Microsoft separately specifies double-width headline, description and path allowances and includes emoji; mixed scripts need vendor-aware validation, not a blanket copied Google rule.
- LinkedIn counts spaces, punctuation and emoji in introductory text, caps emoji separately, and shortens long URLs. X reserves a fixed allowance per URL rather than counting the literal link length. Neither rule establishes a general Unicode counter for other platforms.
- Device, placement and rendering can change how much text is visible.
- OM's Google translation enforces headline/description lengths and asset counts; its TikTok translation caps text at 100.
