# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/formbricks-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `formbricks` — already built, do **not** re-index

## Licence — MIT slice YES · apps/web NO · ee/ NO

Three tiers. **AGPLv3 by default** (`LICENSE:1-9`). Proprietary **EE** for
`apps/web/modules/ee/` (433 files, 79,548 LOC), enforced by a **live network check** to
`ee.formbricks.com/api/licenses/check` with 24h cache and 3-day grace
(`apps/web/modules/ee/license-check/lib/license.ts:26-44`) — the only genuinely enforced gate
in the survey.

**MIT and takeable:** `packages/js-core`, `packages/surveys`, `packages/survey-ui`.

⚠️ The root LICENSE's MIT whitelist names `packages/js/`, `packages/android/`, `packages/ios/`,
`packages/api/` — the first is named differently in this tree and the other three **do not exist
in it**. The umbrella text cannot be read literally against this checkout. Worth counsel.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

The MIT survey/form renderer — relevant because Open Marketing needs its own `forms` module
(`@jini-ai/cms` has no forms tree) and this is the one liftable renderer in the survey.

Also the cautionary case on preview fidelity: it maintains **two independent implementations**
of its conditional-logic evaluator, one for the widget runtime and one for the editor preview,
with near-identical complexity — which is what identical-by-copy looks like right before it
stops being identical.
