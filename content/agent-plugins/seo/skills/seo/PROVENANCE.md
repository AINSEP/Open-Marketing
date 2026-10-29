# Provenance

Optional skills-only Agent Plugins 1.0.0 package, version 0.1.0. Both enabled
and admitted default to false; no executable capabilities are declared.
OM automatically seeds this package into the bundled Add-ons catalog and includes
it in desktop packaging, disabled by default. Enable it separately; upload remains
available for other installations. Example requests after enablement: “Review this page HTML for SEO” or “Draft a content plan from this brief”.

## Immutable upstream sources

Retrieved through the GitHub connector on 2026-10-25. Each file was read at the
full commit below, including its root MIT license. Hashes are Git blob SHA-1
object IDs returned for the original bytes, not hashes of the adaptations.
Each file link identifies the exact revision; no mutable branch is required.

### AgriciDaniel/claude-seo

Revision: [6be93f45064ffbadced572b5d5c95f55fd263af0](https://github.com/AgriciDaniel/claude-seo/commit/6be93f45064ffbadced572b5d5c95f55fd263af0).

| Source path | Git blob SHA-1 |
|---|---|
| [LICENSE](https://github.com/AgriciDaniel/claude-seo/blob/6be93f45064ffbadced572b5d5c95f55fd263af0/LICENSE) | `94fac7465f1e76414fc59f9fd97cdfd2105e030d` |
| [skills/seo/SKILL.md](https://github.com/AgriciDaniel/claude-seo/blob/6be93f45064ffbadced572b5d5c95f55fd263af0/skills/seo/SKILL.md) | `723ff9b47b9af3d4a79fc6d7d7a3da0a64a2f3d5` |
| [skills/seo-technical/SKILL.md](https://github.com/AgriciDaniel/claude-seo/blob/6be93f45064ffbadced572b5d5c95f55fd263af0/skills/seo-technical/SKILL.md) | `2184128105f866eb04c10d3d2fcd50d079d41f03` |

## Adaptations and boundaries

- Condensed the root review/planning workflow and selected technical checks into
  skills/seo/SKILL.md: crawlability, indexing signals, content, internal links,
  rendering evidence and structured-data review.
- Replaced host commands and orchestration with evidence-based guidance usable
  from supplied material or existing authorised OM tools. Missing evidence is
  reported explicitly; no external fetching is mandatory.
- Removed launchers, scripts, setup, delegation, optional integrations, numeric
  scores, promotional footers, fixed thresholds and ranking promises.
- Did not import the linked FLOW material (CC BY 4.0), external references,
  scripts or third-party content. The selected skill frontmatter declares MIT;
  only the selected MIT guidance is adapted here.

The manifest and OM-specific boundaries are authored for this adaptation. The
LICENSE file retains the full upstream MIT notice and adds AINSEP copyright for
the OM adaptation.

## Review and validation limits

Manifest fields and matching skill frontmatter follow OM's existing plugin
inspection and instruction-export contracts. Essential guidance is inside
SKILL.md, below the host's 64 KiB bound. This package has no backend, credentials,
MCP transport, tool grants, dependencies or runtime imports. It changes no
shared contracts, callers, adapters or migrations.

Content examples were reviewed as static guidance only. No automated tests,
build, install, activation, crawler run, message send or live vendor action was
performed. No runtime enforcement or end-to-end installation success is claimed.
Topic guidance is practitioner advice; missing evidence stays unverified.
