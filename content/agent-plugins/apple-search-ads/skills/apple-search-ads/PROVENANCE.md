# Provenance: apple-search-ads marketing guidance

Adapted for OM on 2026-10-28 from Daniel Agrici's `claude-ads` (MIT).
Revision: `fc3908e786c318776df89a3a098333da377364be`; sources and license fetched at this revision.
- [Source: ads-apple/SKILL.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/skills/ads-apple/SKILL.md)
- [Source: apple-audit.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/ads/references/apple-audit.md)
- [Upstream license](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/LICENSE)

Retained: original review questions about keyword themes, discovery overlap, listing relevance, evidence-led bidding and installs versus downstream outcomes.
Removed: API lifecycle/version dates, conductor, scoring, scripts, JSON contracts, shared references and mutation gates; no cited third-party prose adapted.
OM additions: operational prefix preserved; catalog/approval boundary, structure-as-plan caveat and playbook pointers. GitHub main-HEAD lookup failed; no current-HEAD claim.

## Vendor facts checked

- [Campaign structure](https://ads.apple.com/app-store/best-practices/campaign-structure) — fetched 2026-10-28: Apple suggests four search-results themes (brand, category, competitor, discovery); exact match and Search Match off for the first three; discovery uses broad match with Search Match off plus a keyword-free Search Match group; other themes' keywords become exact-match negatives in discovery. Suggestions, not requirements.
- No bid amounts, budget minimums, asset limits, regional availability claims or API lifecycle dates stated in the added guidance.

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
