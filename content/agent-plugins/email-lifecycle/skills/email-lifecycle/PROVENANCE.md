# Provenance

Optional skills-only Agent Plugins 1.0.0 package, version 0.1.0. Both enabled
and admitted default to false; no executable capabilities are declared.
OM automatically seeds this package into the bundled Add-ons catalog and includes
it in desktop packaging, disabled by default. Enable it separately; upload remains
available for other installations. Example requests after enablement: “Draft a welcome sequence from this brief” or “Review these delivery reports”.

## Immutable upstream sources

Retrieved through the GitHub connector on 2026-10-25. Each file was read at the
full commit below, including its root MIT license. Hashes are Git blob SHA-1
object IDs returned for the original bytes, not hashes of the adaptations.
Each file link identifies the exact revision; no mutable branch is required.

### jacquescorbytuech/email-marketing-skill

Revision: [b781fdadc06008b810edf6fca91671068f11168e](https://github.com/jacquescorbytuech/email-marketing-skill/commit/b781fdadc06008b810edf6fca91671068f11168e).

| Source path | Git blob SHA-1 |
|---|---|
| [LICENSE](https://github.com/jacquescorbytuech/email-marketing-skill/blob/b781fdadc06008b810edf6fca91671068f11168e/LICENSE) | `9c031c77acd76f553a662a55a29b5c320134c99a` |
| [email-marketing/SKILL.md](https://github.com/jacquescorbytuech/email-marketing-skill/blob/b781fdadc06008b810edf6fca91671068f11168e/email-marketing/SKILL.md) | `9b2f8127b2d714eaacfed722c641a2f13931cf2c` |
| [email-marketing/workflows.md](https://github.com/jacquescorbytuech/email-marketing-skill/blob/b781fdadc06008b810edf6fca91671068f11168e/email-marketing/workflows.md) | `683b30aeb246ba969de98dcb2f980d87bad54cc5` |

### jacquescorbytuech/crm-open-knowledge-wiki

Revision: [4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7](https://github.com/jacquescorbytuech/crm-open-knowledge-wiki/commit/4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7).

| Source path | Git blob SHA-1 |
|---|---|
| [LICENSE](https://github.com/jacquescorbytuech/crm-open-knowledge-wiki/blob/4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7/LICENSE) | `9c031c77acd76f553a662a55a29b5c320134c99a` |
| [foundations/automation-and-sequences.md](https://github.com/jacquescorbytuech/crm-open-knowledge-wiki/blob/4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7/foundations/automation-and-sequences.md) | `85df2fef48e03ef910ca4703b70e2267589c6ad2` |
| [foundations/deliverability.md](https://github.com/jacquescorbytuech/crm-open-knowledge-wiki/blob/4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7/foundations/deliverability.md) | `1a67791685b68c6fc2ba90819d6a39c0293643bf` |
| [measurement/holdouts-and-control-groups.md](https://github.com/jacquescorbytuech/crm-open-knowledge-wiki/blob/4919c3bbcb8f92a6590cfb6ed34a3e71cd6c5ed7/measurement/holdouts-and-control-groups.md) | `b21d6d8a74135bcdc06df2056899c52f28400c69` |

## Adaptations and boundaries

- Adapted the Email Marketing Skill's task scope and workflows into one
  skills/email-lifecycle/SKILL.md, including briefs, sequence/copy formats and
  the ordered deliverability diagnosis.
- Embedded a compact wiki-derived reference covering flow entry/exits,
  suppression, welcome/re-engagement, evidence limits and holdout design.
  Omitted linked third-party articles and their numerical claims.
- Removed mandatory live wiki fetching, local reference dependencies,
  host-specific assumptions, cross-channel execution, legal assurances,
  universal timing/volume rules and unverified performance claims.
- Example delays are illustrative planning assumptions. Tests, enrolment,
  scheduling, message dispatch, suppression changes and DNS edits are not
  implemented by this package. Normal OM server policy remains authoritative.

The manifest and OM-specific boundaries are authored for this adaptation. The
LICENSE file retains the full MIT notice shared by both email upstreams and adds
AINSEP copyright for the OM adaptation.

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
