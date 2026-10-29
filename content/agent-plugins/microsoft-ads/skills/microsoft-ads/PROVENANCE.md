# Provenance: microsoft-ads marketing guidance

Adapted for OM on 2026-10-28 from Daniel Agrici's `claude-ads` (MIT).
Revision: `fc3908e786c318776df89a3a098333da377364be`; sources and license verified at this revision.
- [Source: ads-microsoft/SKILL.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/skills/ads-microsoft/SKILL.md)
- [Source: microsoft-audit.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/ads/references/microsoft-audit.md)
- [Upstream license](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/LICENSE)

Retained: original review questions about Search intent, imports, network distribution, keywords/negatives, UET and conversion-informed bidding; verify actual capability before proposing changes.
Removed: conductor, scoring, scripts, JSON contracts, shared/creative-spec references, transport-deprecation dates and mutation gates; no cited third-party prose adapted.
OM additions: existing operational instructions preserved; server-approval boundary and shared-playbook pointers, including RSA limits rather than duplicated counts.

## Vendor facts checked

- [ResponsiveSearchAd](https://learn.microsoft.com/en-us/advertising/campaign-management-service/responsivesearchad?view=bingads-13) — fetched 2026-10-28: Search text assets can be combined per query; format eligibility is conditional. No asset counts or character limits copied.
- [UET setup](https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_conc_uet_setup_master) — fetched 2026-10-28: website tag installation and verification support conversion tracking.
- [Google Ads import mapping](https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_conc_importwhatinfo) — fetched 2026-10-28: settings require review; network/location and negative-list mappings, bid/budget adjustments and scheduled imports can affect the resulting campaigns. No budget or bid figures stated.

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
