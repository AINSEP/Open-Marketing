# Provenance: google-ads marketing guidance

Adapted for OM on 2026-10-28 from Daniel Agrici's `claude-ads` (MIT).
Revision: `fc3908e786c318776df89a3a098333da377364be`; sources and license fetched and verified in this run.

- [Source: ads-google/SKILL.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/skills/ads-google/SKILL.md)
- [Source: google-audit.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/ads/references/google-audit.md)
- [Upstream license](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/LICENSE)

Retained: search-term evidence, business-relevance and overblocking review before negatives; separate positive/negative inventories; scoped negative-match self-blocking review; supported, reversible recommendations.
Removed: control IDs, scoring, conductor, scripts, JSON contracts, gaql-notes, shared references and dated API/migration items; no cited Google text adapted.
OM additions: operational text preserved, approved description clause, server authority and bounded Search boundary, owner-supplied search-term evidence, playbook pointers and measurement-grant/consent caveats. Vendor facts below are independently paraphrased.

## Vendor facts checked

- [Keyword matching](https://support.google.com/google-ads/answer/7478529?hl=en) — fetched 2026-10-28: exact matches same meaning/intent, phrase includes meaning, broad reaches related searches; Google stresses Smart Bidding with broad match.
- [Negative keywords](https://support.google.com/google-ads/answer/2453972?hl=en) — fetched 2026-10-28: broad/phrase/exact negative rules differ from positives; broad requires all terms; no close-variant expansion, so review synonyms/singular/plural separately. Scope matters; excess negatives reduce reach.
- [Smart Bidding](https://support.google.com/google-ads/answer/7065882?hl=en) — fetched 2026-10-28: optimizes conversions or conversion value; conversion tracking required; strategy-specific historical-data recommendations need checking. No thresholds retained.
- [PMax asset groups](https://support.google.com/google-ads/answer/10724748?hl=en) — fetched 2026-10-28: themed text/image/video/logo/final-URL groups; multiple groups per campaign; Final URL expansion can substitute landing pages; missing video may be generated.
- [Demand Gen](https://support.google.com/google-ads/answer/13695777?hl=en) — fetched 2026-10-28: campaign creative previews support audience/channel review. This page does not establish where audience/location/channel settings live; no setting-level claim retained.
- [Primary/secondary actions](https://support.google.com/google-ads/answer/11461796?hl=en) — fetched 2026-10-28: primary actions enter Conversions/bidding when their goal is used; secondary enter All conversions, but custom goals use included secondary actions for bidding; frequent budget/target/goal changes can reset learning.
- [Enhanced Conversions](https://support.google.com/google-ads/answer/9888656?hl=en) — fetched 2026-10-28: measurement supplemented with hashed first-party data. Detailed setup and customer-data policy requirements deferred to current docs.
- [Consent-mode modeling](https://support.google.com/google-ads/answer/10548233?hl=en) — fetched 2026-10-28: modeled conversions enter Conversions and bidding, distinct from observed paths/outcomes; eligibility conditions apply. No threshold retained.
- Not fetched/confirmed: detailed Demand Gen setting placement; PMax search-theme/negative mechanics; additional consent-mode variants/parameters. These defer to current Google Ads docs or are omitted. Asset counts/ratios, learning durations, budget/volume thresholds and dated migration claims are omitted; RSA limits defer to ad-copy-variants.

## Upstream MIT notice (retained in full)

MIT License

Copyright (c) 2026 Daniel Agrici (AgriciDaniel)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
