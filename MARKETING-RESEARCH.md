# Marketing research — where it lives

**None of it is in this repo.** This file is the pointer, so a new session can go
straight there.

This repo is the Open Design fork, mid OD→OM rebrand. Its `docs/` holds Open Design
framework docs. The Open Marketing product research and design work lives in a separate
directory on this machine.

## Go here

```
/Users/la/Programming/OSS-Marketing-Repos/
├── docs/
│   ├── README.md                     ← index of everything below
│   ├── capability-synthesis.md       ← READ FIRST (~1,500 lines)
│   ├── open-marketing-build-plan.md  ← the plan to build from
│   ├── architect-reviews/            ← five model reviews + the brief
│   └── <repo>-architecture.md        ← 12 per-repo deep dives
├── chatwoot/ dittofeed/ formbricks/ inngest/ jitsu/ listmonk/
├── matomo/ novu/ posthog/ rudder-server/ trigger.dev/ unomi/
└── (each clone has an OM-NOTES.md pointing back at its doc)
```

## What each thing is

**`docs/capability-synthesis.md`** — the survey's conclusions, organized by capability
rather than by repo: journeys, segmentation, incremental recompute, sending,
deliverability, templating, consent/compliance, identity, ingestion, webhooks. Then a
per-repo licensing table, a build order, and a "what nobody solved well" section. It
supersedes the per-repo docs for decision-making; read those only for the detail behind a
specific claim.

**`docs/open-marketing-build-plan.md`** — the architecture and build plan, synthesized from
five independent model reviews (GPT-6-Astra, Opus 5, Fable 5.1, Gemini 3.1 Pro, Gemini 3.8
Flash) run against one brief. Module list marked NEW/JINI/EXTERNAL, the three gate
functions, the tool surface with risk tiers, the money boundary, analytics truth model,
build order, and the disagreements that stayed open. Also published as an artifact.

**`docs/architect-reviews/`** — the five full answers behind that plan, plus the final brief
and a `superseded/` folder of earlier rounds. Kept because the plan necessarily compressed
them; the Opus review alone is ~8,300 words.

**`<repo>/OM-NOTES.md`** — inside each clone: which doc covers it, its licence verdict, its
cbm index name, and what it was mined for.

## Two things to know before using any of it

**Licensing is the binding constraint, not code quality.** Seven distinct patterns across
eleven repos, including a live network licence check (formbricks), an enterprise package
absent from the tree (dittofeed), an unchecked-out submodule (novu), and SSPL that
auto-relicenses to Apache after three years (inngest). listmonk is AGPLv3 whole-tree and
rudder-server is Elastic License 2.0 — both ideas-only. The synthesis has the per-repo
table. Do not lift code without reading it.

**Do not re-index these repos.** cbm indexes already exist for all eleven — `chatwoot`,
`dittofeed`, `formbricks`, `inngest`, `jitsu`, `listmonk`, `matomo`, `novu`,
`rudder-server`, `trigger-dev`, `unomi` — plus `Jini`, `Tovu` and this repo. Running
several concurrent indexers previously drove this machine into severe memory pressure, and
`TaskStop` does not reliably kill a cbm index worker.

## Also worth knowing

- **The real Open Marketing product repo** (`github.com/leonaburime-ucla/Open-Marketing`) is
  at `/Users/la/Programming/delete-later/Open-Marketing-bare`, with `open-design` as a
  submodule and `integrations/mautic` (313 MB) inside it. Still under a directory named
  `delete-later`.
- **Mautic has no clone** in `OSS-Marketing-Repos` — only the one inside that repo.
- **PostHog was deliberately excluded** from the survey as product analytics rather than
  marketing automation. The clone exists; no doc, and nothing in the synthesis draws on it.
- `OSS-Marketing-Repos` is **not a git repo** — everything there is unversioned and
  unbacked-up.
