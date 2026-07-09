# Handoff — Settings section-registry refactor (#2) — 2026-06-30

## TL;DR
Refactoring **this repo's** rich `SettingsDialog` (NOT porting Open-Marketing-old —
that's a feature-poor regression) into a section registry, incrementally, app green
each step. Registry + 2 sections extracted and committed. Then hit a **pre-existing
test blocker from task #1 (agui)**: web unit tests can't load because of a copilotkit
`.css` import. Was mid-fix when handoff requested.

## Branch / commits
On branch `settings-section-registry` (off `main`). Two commits:
- `bed5ad31` — `SETTINGS_NAV` registry drives the sidebar (replaced 17 hand-written
  nav buttons with one `.map`, −174 lines, identical DOM); extracted `AppearanceSection`.
- `ffce9a84` — extracted `CritiqueTheaterSection`; pruned dead imports.

**Everything else is still uncommitted** (~68 paths: agui-copilot, marketing engine,
Vite, etc.). The two settings commits are isolated on this branch; the rest of the
working tree rides along.

## What changed (files)
- `apps/web/src/components/settings/sections.ts` — NEW typed `SETTINGS_NAV` registry
  (`id/icon/title(t)/subtitle(t)`). Single source for the sidebar. `SettingsSection`
  type imported type-only from `./SettingsDialog` (no runtime cycle).
- `apps/web/src/components/settings/sections/AppearanceSection.tsx` — NEW, moved verbatim
  (+ its `THEMES` const). Appearance helpers already shared in `state/appearance.ts`.
- `apps/web/src/components/settings/sections/CritiqueTheaterSection.tsx` — NEW, moved verbatim.
- `apps/web/src/components/settings/SettingsDialog.tsx` — nav block → `SETTINGS_NAV.map`;
  removed the two inline sections; added their imports; pruned 7 now-dead imports.

## KEY GOTCHA: web `noUnusedLocals` is OFF
`tsc -b` stays green even when an extraction strands imports in the monolith. So
extraction hygiene is manual: after removing a section, grep each symbol it used —
`grep -cE '\bSYM\b' SettingsDialog.tsx` == 1 means import-only → dead → remove it.
(Kept `applyAppearanceToDocument`/`resolveAccentColor` — still used elsewhere.)

## Current blocker (BELONGS TO TASK #1, not #2)
Web unit tests fail to LOAD (0 tests run):
`TypeError: Unknown file extension ".css"` from `@copilotkit/react-core/.../index.css`.
Chain: `SettingsDialog → ../../App → ./agui-copilot/CopilotProvider →
@copilotkit/react-core/v2/styles.css`. The agui work added a node_modules CSS import
into App's graph; `apps/web/vitest.config.ts` uses `environment: 'node'` and
externalizes node_modules, so Node's loader chokes. Local `.css` was always fine
(Vite transforms it to empty) — only node_modules CSS breaks. This blocks ALL web
component tests touching App/SettingsDialog, so it predates and is independent of #2.

### Fix in progress (do this next)
Created `apps/web/tests/helpers/css-stub.ts` (`export default {}`). STILL NEED to wire
it: in `apps/web/vitest.config.ts` switch `resolve.alias` from object to array form and
add `{ find: /\.css$/, replacement: resolve(__dirname, 'tests/helpers/css-stub.ts') }`
(keep the existing `motion/react` alias). Then run:
`cd apps/web && pnpm vitest run tests/components/SettingsDialog.test.ts tests/components/SettingsDialog.execution.test.tsx`
Expect green — proves the refactor didn't break behavior. This config/stub change
should land with the **agui (#1)** work, not the settings branch.

## Do the tests need to change? NO.
Tests import via the shim `src/components/SettingsDialog` (re-exports everything),
so they still resolve. The refactor is output-identical (nav DOM) / verbatim
(sections), so the existing suites are the regression net, not collateral:
- Unit: `apps/web/tests/components/SettingsDialog.{test.ts,execution,media,orbit}` +
  `App.{connectors,mediaProviders,...}`.
- E2E (Playwright, `e2e/ui/`): `visual-settings`, `settings-*`, `critical-smoke`, etc.
Only add NEW tests if/when a section gains behavior; none need rewriting for the move.

## Manual smoke (what should work — open Settings)
- Sidebar: all sections render, same order/icons/labels; composed labels intact
  ("Local CLI / API", "Image / video / audio"); active highlight on click.
- Appearance: theme system/light/dark live-applies; accent swatches + custom color picker.
- Critique Theater: toggle; project vs no-project hint differs.
NOTE: the running daemon/web (`pnpm tools-dev status`) is on OLD code — restart web to test.

## Next steps (incremental, same pattern)
1. Wire the css stub + run settings tests green (above).
2. Extract remaining in-file sections: `NotificationsSection` (bigger — pulls notif
   permission state + sound utils + `soundIdToTracking` helper), `MediaProvidersSection`,
   `OrbitSection`, `IntegrationsSection`. `ConnectorSection` is exported + used externally → care.
3. Structural (later): drive the header title/subtitle map (`sectionHeader`, ~line 2895)
   and the `if (activeSection === …)` content switch from the registry. `execution` LAST
   (most coupled, 29 useState live in the shell).

## Context / decisions
- Memory `project_settingsdialog-rewrite.md` updated with the decision reversal +
  progress. Architecture opinion (vertical slices > horizontal layering; thin shell +
  pure-logic lib; mind upstream-merge drift) discussed but NOT acted on — staying
  incremental on purpose.
- Other open tasks untouched: #1 agui chat (engine fixes done earlier today, see
  `handoffs/2026-06-30-agui-copilot-chat.md`), #3 OD→marketing swap (not started).
