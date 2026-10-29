# Provenance: snapchat-ads marketing guidance

Adapted for OM on 2026-10-28 from Daniel Agrici's `claude-ads` (MIT).
Revision: `fc3908e786c318776df89a3a098333da377364be`; sources and license verified at this revision.
- [Source: ads-snapchat/SKILL.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/skills/ads-snapchat/SKILL.md)
- [Source: snapchat-audit.md](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/ads/references/snapchat-audit.md)
- [Upstream license](https://github.com/AgriciDaniel/claude-ads/blob/fc3908e786c318776df89a3a098333da377364be/LICENSE)

Retained: original campaign/squad/ad alignment, audience-intent, mobile-creative, measurement-path and budget/pacing review questions from SC-* controls.
Removed: conductor, scoring, scripts, JSON contracts, shared methods, mutation gates, API dates, optional product labels and universal thresholds; no cited third-party prose adapted.
OM additions: operational prefix preserved; advisory authority line, existing-creative traffic boundary, swipe-versus-signup distinction and six om-playbook pointers.

## Vendor facts checked

- [Ad squads](https://developers.snap.com/api/marketing-api/Ads-API/ad-squads) — fetched 2026-10-28: a squad belongs to a campaign and contains ads; its fields include targeting, budget, bid, optimization goal, placement and schedule; SWIPES is an optimization goal. No named bid strategies or budget minimum retained.
- [Creative help page attempted](https://businesshelp.snapchat.com/s/article/snap-ads-specs?language=en_US) — official creative page not fetchable on 2026-10-28; marketing guidance states no Snapchat media specs and defers to current docs. Existing operational facts were preserved, not revalidated.

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
