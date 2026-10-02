# Formbricks Architecture — Reference Analysis

> Reference-only analysis of upstream Formbricks, done to decide **what to port** into the
> Open Design–based Open Marketing repo (**Next.js/Electron**). Of the 12 OSS repos surveyed,
> Formbricks is the closest stack match — Next.js App Router, TypeScript, Prisma/Postgres —
> so unlike the others, its *implementation* is weighed for near-as-is lifting, not just ideas.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/formbricks` (clone of
>   `github.com/formbricks/formbricks`, analyzed at commit `c6f9af98`, 2026-07-01)
> - **Tools:** codebase-memory-mcp (project `formbricks`, moderate mode) + graphify
>   (`graphify-out/formbricks-2d25f9e5/`, Tree-sitter, no LLM) + direct source reads.
> - **Date:** 2026-09-06

## Section 0 — Premise corrections and self-corrections

**Corrections to the dispatch brief:**

- The brief's implicit "MIT vs. proprietary-EE" two-tier framing (calibrated from Chatwoot and
  Dittofeed) **does not fit this repo**. Formbricks' root `LICENSE` declares **three** tiers —
  AGPLv3 (default), a restrictive Enterprise Edition license (`apps/web/modules/ee/`), and MIT
  (a named whitelist of package paths) — and the AGPLv3 default is itself a materially
  different constraint from Chatwoot's permissive MIT core (`LICENSE:1-9`). This is the
  decision-changing finding for this repo, sharper than either prior one.
- The whitelist in the root `LICENSE` (`packages/js/`, `packages/android/`, `packages/ios/`,
  `packages/api/`) **does not match this checkout's directory names**, and three of the four
  named paths **do not exist in this clone at all** — see Licensing below. This is a real gap
  between the license text and the tree, not a reading error.
- No prior assumption about the classic Formbricks `Organization → Project → Environment
  (production/development)` hierarchy holds. `Environment` has been **removed as a database
  model** in this commit — `packages/database/migration/20260403000000_remove_environment_model/`
  — and `Workspace` (formerly "Project") is now the direct tenant unit under `Organization`.
  `Workspace.legacyEnvironmentId` (`schema.prisma:604`) is the only trace, kept for
  backward-compatible ID resolution. Public API paths still say `/environment` and
  `/api/v1/client/[workspaceId]/environment/...` for the same historical reason — the noun
  survives in the wire protocol after the model it named was deleted.

**Self-corrections found while re-verifying Pass A in Pass B:**

- Initial read of `packages/js-core` (via `find -maxdepth 2`) showed only 8 files and undercounted
  its `lib/` tree; the real widget SDK is 57 files across `lib/common`, `lib/survey`, `lib/user`,
  `lib/workspace` (`packages/js-core/src/lib/**`). Corrected before drawing SDK conclusions.
- Initially treated `Contact`/`Segment`/`ContactAttribute` as core-tier (AGPLv3) targeting
  primitives because they're in the shared Prisma schema. Verified against the actual read/write
  code path and found the opposite: identifying a user and evaluating segment membership is
  **entirely implemented under `apps/web/modules/ee/contacts/`**, and is **runtime-gated** behind
  a real, network-verified Enterprise license check (`getIsContactsEnabled`,
  `apps/web/app/api/v1/client/[workspaceId]/user/route.ts:137-145`) — not merely organized under
  an `ee/` folder for convenience. Corrected before writing the targeting section.
- cbm's `Route` node extraction was assumed (per the dispatch brief's own calibration notes) to
  at least partially work on any indexed TypeScript backend, per the Dittofeed/Fastify precedent.
  Verified directly with a Cypher query (`MATCH (r:Route) RETURN r.method, r.path, r.file_path,
  r.handler`) and found it **does not work on Next.js App Router route.ts files at all** — see
  Tool Calibration. This is worse than either prior repo's Route-node result, not merely "also
  imperfect."

**What could not be verified:** actual production request volume/latency, Formbricks Cloud's
Stripe entitlement plumbing beyond what's readable in `apps/web/modules/billing/` (external
Stripe state is invisible from source), and whether `packages/api`/`android`/`ios` exist in the
live upstream monorepo or only in a different repo the LICENSE text was written for — this clone
simply doesn't have them (see Licensing).

## TL;DR

- **Code quality: 6/10. Marketing port value: 7/10.** The engineering is disciplined where it's
  been recently touched (webhook delivery, license gating, response ingestion) and shows real
  scar tissue elsewhere (a 569-cognitive-complexity condition validator, duplicated survey-logic
  evaluators). The domain — surveys, in-product targeting, triggers, webhooks — overlaps Open
  Marketing's needs less than a full journey/segment engine (cf. Dittofeed, 9/10) but more than a
  support inbox (cf. Chatwoot, 4/10): Formbricks is strong on **event-triggered, in-app
  micro-surveys** and **secure webhook/SDK delivery**, weak on sequencing/journeys (none) and
  email-native marketing (none — it's XM/survey-first, not lifecycle-messaging-first).
- **Licensing is a three-way split, and it's messier than either prior repo.** AGPLv3 is the
  default license for everything not explicitly carved out (`LICENSE:1-9`) — a materially
  stronger copyleft than Chatwoot's MIT core. `apps/web/modules/ee/` (433 `.ts`/`.tsx` files,
  79,548 LOC) is under a **real, network-enforced** Enterprise license — not a directory-presence
  check like Chatwoot's `enterprise?` flag, but a live call to `ee.formbricks.com/api/licenses/check`
  with 24h cache / 3-day grace period (`apps/web/modules/ee/license-check/lib/license.ts:36-44`).
  The **entire contact-identification and segment-targeting subsystem lives inside that
  EE-gated boundary** — self-hosting without a paid license means app surveys can only target by
  trigger (action class) and simple built-in filters, never by contact attribute or segment.
- **The crown jewel is the webhook/response pipeline, not the survey editor.** Response creation
  is synchronous and transactional (Postgres `$transaction` wrapping both the insert and quota
  evaluation), while webhook delivery, integrations, follow-up email, and billing metering are
  deferred to a BullMQ queue with per-job retry and a genuinely hardened SSRF-resistant webhook
  sender (DNS-pinned dispatcher, manual-redirect blocking, Standard Webhooks signing). This is
  more production-grade than either Chatwoot's or Dittofeed's equivalent, and it is the single
  highest-value near-as-is port target given the shared TypeScript/Next.js stack.
- **Port strategy:** take the webhook delivery pattern and the license-gating pattern almost
  verbatim (both are stack-independent good engineering); take the trigger taxonomy (page view,
  click, exit intent, scroll depth, time-on-page, custom code) as a real, portable event model;
  treat the segment JSON-filter shape as a decent reference but rewrite the evaluator (it's
  EE-only source and duplicated even within this repo); do not expect a journey or sequencing
  engine — there isn't one.

## What it is

A **Next.js 15 / React 19 / TypeScript** Turborepo (pnpm workspaces), Postgres via Prisma,
Redis-backed caching, BullMQ for background jobs. 3,991 tracked files (excluding `.git`).
cbm indexed 17,895 nodes / 49,039 edges (32 dirs auto-excluded: fixtures, mocks, locales, docs).
graphify indexed 15,792 nodes / 40,868 edges / 827 communities, 99% EXTRACTED / 1% INFERRED —
very clean TypeScript resolution, on par with Dittofeed's 99/1 and well above Chatwoot's 92/8.

**Layout:** one app (`apps/web`, 2,202 `.ts`/`.tsx` files) plus a Storybook app, and 16 packages.
`apps/web` is internally a **modular monolith**: `apps/web/modules/<feature>/{lib,components,api,
types}` for ~24 top-level feature modules (`survey`, `auth`, `billing`, `integrations`, `mcp`,
`storage`, `organization`, …) plus the walled-off `apps/web/modules/ee/` (17 EE feature modules:
`contacts`, `billing`, `sso`, `saml` auth, `two-factor-auth`, `audit-logs`, `quotas`,
`role-management`, `whitelabel`, `feedback-directory`, `unify-feedback`, `ai-translation`,
`analysis`, `mailing`, `teams`, `license-check`, `entitlements`-adjacent).

| Package | Role | License (self-declared) |
|---|---|---|
| `js-core` | Widget/embed SDK (Vite build, loaded as `<script>`) | MIT |
| `surveys` | Preact-based survey renderer, loaded on demand by `js-core` | MIT |
| `survey-ui` | React 19 question-rendering components, shared by the app's editor/preview | MIT |
| `database` | Prisma schema (1,318 lines), 177 migrations, seed scripts | none declared → AGPLv3 by default |
| `types` | Shared Zod schemas + TS types | none declared → AGPLv3 by default |
| `jobs` | BullMQ queue/worker contracts, generic (no app logic) | none declared |
| `email`, `ai`, `cache`, `storage`, `logger`, `i18n-utils`, `vite-plugins` | Infra/cross-cutting | mixed (`logger`, `i18n-utils`, `vite-plugins` self-declare MIT; `email`, `ai`, `cache`, `storage` don't) |

Dependency direction (cbm `boundaries`): `web → email` (1,001 calls, dominated by one hotspot —
see below), `web → surveys` (569), `web → types` (442), `web → js-core` (127), `web → database`
(11). `formbricks → web` (19) is the CLI/migration package calling into web's Prisma layer, not a
reverse dependency of note.

## Licensing (read this before porting anything)

Formbricks' root `LICENSE` (`LICENSE:1-9`) declares:

```
- apps/web/modules/ee/*        → Enterprise Edition license (apps/web/modules/ee/LICENSE)
- packages/js/, packages/android/, packages/ios/, packages/api/  → MIT
- everything else               → AGPLv3
```

Three problems with taking that at face value in this checkout:

1. **The MIT whitelist paths don't match this tree.** There is no `packages/js/` (it's
   `packages/js-core/`), and `packages/android/`, `packages/ios/`, `packages/api/` **do not
   exist in this clone at all** — `find packages -maxdepth 1` lists 16 packages, none of them
   `android`, `ios`, or `api`. Either those live in separate repos/mobile-SDK projects not
   included here, or the LICENSE text is stale relative to this monorepo's actual layout. Either
   way, the umbrella LICENSE's own whitelist cannot be read literally against this source tree.
2. **Individual `package.json` files self-declare MIT more broadly than the whitelist covers.**
   `js-core`, `surveys`, `survey-ui` (the client-delivered/rendering packages — a reasonable
   match for the LICENSE's spirit) *and* `logger`, `i18n-utils`, `vite-plugins`,
   `config-prettier` (internal build tooling, not named or implied by the whitelist) all carry
   `"license": "MIT"`. `database`, `types`, `jobs`, `ai`, `cache`, `storage`, `config-eslint`,
   `config-typescript` declare no license field at all, which under the root LICENSE's own
   default clause makes them **AGPLv3**, not the "everything in `packages/` is basically MIT"
   assumption a skim might produce.
3. **The EE LICENSE's own carve-out is narrower than "the `ee/` folder."** Its text
   (`apps/web/modules/ee/LICENSE:23-28`) exempts anything "served client-side as an image, font,
   CSS, [or] file which produces or is compiled, arranged, augmented, or combined into
   client-side JavaScript" — i.e. even EE-authored logic that ends up inside the widget bundle
   shipped to end-user browsers reverts to MIT/AGPL terms. This matters because `packages/surveys`
   and `packages/survey-ui` are exactly that: client-delivered JS, self-declared MIT, consistent
   with both the package-level declaration and the carve-out clause. Treat those two as genuinely
   safe to study closely; treat `logger`/`i18n-utils`/`vite-plugins`'s MIT self-declaration as
   probably fine (internal tooling, no client delivery, no plausible copyright interest) but not
   backed by the umbrella LICENSE text the way `surveys`/`survey-ui` are.

**Practical read:** `apps/web` outside `modules/ee/` — 252,994 LOC across the app's routes,
non-EE modules, and `apps/web/lib` — is **AGPLv3**, a copyleft that (unlike Chatwoot's MIT core)
imposes network-use source-disclosure obligations if incorporated into a hosted service. `apps/web/
modules/ee/` — 433 files, 79,548 LOC — is proprietary and **not portable at all** without a
commercial agreement (development/testing copying is explicitly permitted by the EE license text,
production use is not). `packages/js-core` + `packages/surveys` + `packages/survey-ui` — 28,238
LOC combined — are the one tier that is both self-declared MIT and structurally consistent with
the license's carve-out logic: **this is the actually-safe-to-port slice**, and it happens to be
exactly the widget/SDK/renderer, which is also the highest architectural-interest slice for a
marketing product that will ship its own embeddable surface.

**What's absent from the tree entirely:** `packages/android`, `packages/ios`, `packages/api` (see
above) — we cannot evaluate mobile SDK or a dedicated `api` package because they simply aren't
here, the same "invisible gap" pattern as Dittofeed's missing `packages/ee/`, just inverted (there
it was the restricted tier that vanished; here it's part of the permissive tier).

## Domain model

```
Organization ──┬── Membership/Invite/Team/TeamUser        (users, roles: owner/manager/member/billing)
               ├── ApiKey ── ApiKeyWorkspace (permission: read/write/manage)
               ├── OrganizationBilling (Stripe sync, jsonb limits)
               └── Workspace ──┬── Survey ── SurveyTrigger ── ActionClass
                                │         ├── SurveyQuota ── ResponseQuotaLink   [EE]
                                │         ├── SurveyAttributeFilter (equals/notEquals, simple)
                                │         ├── Segment (JSON filter tree)          [EE evaluation]
                                │         ├── SurveyFollowUp, SurveyLanguage/Language
                                │         └── Response ── Display, Tag, TagsOnResponses
                                ├── Contact ── ContactAttribute ── ContactAttributeKey  [EE]
                                ├── Webhook (source: user/zapier/make/n8n/activepieces)
                                ├── Integration (googleSheets/notion/airtable/slack)
                                ├── FeedbackSource/FeedbackDirectory                    [EE]
                                └── Chart, Dashboard, DashboardWidget                   [EE]
```

`Survey.questions`/`.blocks`/`.endings`/`.welcomeCard`/`.variables`/`.hiddenFields` are all JSON
columns (`schema.prisma:359-379`) — the survey definition is data, not a normalized question
table; `blocks` is the newer shape (migration `20251118032116_migrate_questions_to_blocks`)
layered over the legacy `questions` array, both still present and both still selected by the
client-state endpoint (`environment/lib/data.ts:79-80`). `Response.data`/`.variables`/`.ttc`/
`.meta`/`.contactAttributes` are likewise JSON (`schema.prisma:158-198`) — no normalized
per-answer table exists; indexes are only on `(surveyId, createdAt)` and `(contactId, createdAt)`
for monthly-count queries (`schema.prisma:196-198`), meaning per-question analytics are computed
by deserializing JSON at read time, not by SQL aggregation over columns.

## What's good

- **The response-pipeline is genuinely production-grade.** Response creation + quota evaluation
  share one Postgres transaction (`app/api/client/[workspaceId]/responses/lib/response.ts:34-52`);
  webhook/integration/email side effects are deferred to BullMQ with per-job retry
  (`packages/jobs/src/processors/response-pipeline.ts` + the registered override at
  `apps/web/modules/response-pipeline/lib/process-response-pipeline-job.ts:756-827`). Webhook
  delivery signs payloads to the open **Standard Webhooks** spec (`webhook-id`/`webhook-timestamp`/
  `webhook-signature` headers, `process-response-pipeline-job.ts:208-227`), pins the TCP connection
  to the DNS-validated IP to close a rebinding TOCTOU (`createPinnedDispatcher`,
  `process-response-pipeline-job.ts:229-233`), and blocks redirect-based SSRF by refusing to
  follow 30x responses unless an explicit self-hoster opt-out is set (`:236,249-251`).
- **The EE license gate is real, not decorative.** Unlike Chatwoot's `enterprise?` disk-presence
  check, `getEnterpriseLicense()` phones home to `ee.formbricks.com/api/licenses/check` with a
  24h TTL cache, a 10-minute failed-fetch cache, and a 3-day grace-period fallback before
  degrading to a hard default (`license.ts:26-44`), and per-request gates
  (`getIsContactsEnabled`, `getIsQuotasEnabled`, `getIsSsoEnabled`, …) sit directly in the
  request path of both the public client API and the server actions
  (`user/route.ts:137-145`; `responses/route.ts:109-120`).
- **A deliberate, typed public-API sanitization boundary exists for targeting data.** The
  `/environment` endpoint the SDK polls used to leak full segment filter trees to any anonymous
  visitor; it now returns only `{id, hasFilters}` per segment
  (`ZJsWorkspaceStateSegment`, `packages/types/segment.ts:352-357`), with the actual comment
  explaining why: *"The actual segment-membership check happens server-side (segment IDs in
  POST /user); SDKs only inspect `filters.length` / `hasFilters` locally"*
  (`environment/lib/data.ts:144-146`). This reads as a recent, deliberate security fix, not
  incidental design — good evidence of an actively-maintained security posture.
- **Rich, real trigger taxonomy in the SDK**, not just page-load: page view, click (CSS
  selector/inner-text match), exit intent (`clientY <= 0` on `mouseleave`), 50%-scroll-depth,
  time-on-page (per-URL timer), and custom code actions — all in
  `packages/js-core/src/lib/survey/no-code-action.ts:59-352`, with URL filtering shared across
  all of them (`handleUrlFilters`).
- **Bundle-size-conscious widget architecture.** `packages/surveys` (the on-demand-loaded
  renderer) is built on **Preact** (`packages/surveys/package.json`); `packages/survey-ui` (the
  admin dashboard's shared question components) is **React 19**. Splitting the embeddable
  runtime onto a smaller UI library while keeping the authoring app on the full framework is a
  sound, portable pattern for anything we ship as a third-party embed.
- **cbm and graphify agree on the core abstraction.** `TSurvey` is graphify's #1 god node (387
  edges); cbm's top complexity hotspots (`validateConditions` 569, `validateBlockConditions` 434,
  `surveyRefinement` 291) all live in `packages/types/surveys/types.ts`, the module that defines
  and Zod-validates `TSurvey`. Two independent engines pointing at the same file is a
  high-confidence signal that survey-shape validation is both the most central and the most
  complex code in the repo.

## What's weak

### 1. One 569-cognitive-complexity function is the survey-logic gatekeeper
`validateConditions` (`packages/types/surveys/types.ts`) tops the complexity table at cognitive
**569**, with `validateBlockConditions` (434), `validateSingleCondition` (431), and
`surveyRefinement` (291, transitive loop depth 5) immediately behind it — all in the same file, all
part of the Zod `.superRefine` chain that validates a survey's conditional-logic tree at
creation/update time. This is a single-file chokepoint for "is this survey internally
consistent," and it is at genuine risk of being the thing that silently breaks on the next
question-type addition. cbm: 3,306 of the repo's ~5,660 functions have non-zero cognitive
complexity — the complexity budget is not evenly spread, it is concentrated here and in the
editor.

### 2. Survey conditional-logic evaluation is duplicated, not shared
`evaluateSingleCondition` and `getLeftOperandValue` each exist **twice** with matching cognitive
complexity (212/215 and 93/93): once in `packages/surveys/src/lib/logic.ts` (the widget's
runtime branching engine) and once in `apps/web/lib/surveyLogic/utils.ts` (the editor's preview/
validation engine). Two independently-maintained implementations of "does this answer satisfy
this branch condition" is a correctness risk for any survey whose editor-preview and live-render
behavior silently diverge — exactly the kind of thing that should be a single shared package.

### 3. Audience targeting for app surveys is entirely enterprise-only
There is no free/AGPLv3 path to contact-attribute or segment-based targeting. `Contact`,
`ContactAttribute`, `Segment` evaluation, and the `POST /user` identify call all live under
`apps/web/modules/ee/contacts/` and 403 with *"User identification is only available for
enterprise users"* when `getIsContactsEnabled` returns false (`user/route.ts:137-145`,
`responses/route.ts:109-120`). The only targeting available to a self-hosted, unlicensed
instance is trigger-based (which action fired) and the coarse per-survey
`SurveyAttributeFilter` (single equals/notEquals per attribute, no boolean composition) — a
materially weaker free tier than a marketing team evaluating "can we self-host this" might
assume from the AGPLv3 label alone.

### 4. The widget has no strong isolation story
`packages/surveys` renders directly into the host page's DOM (a plain `<div id="fbjs">`
container plus a preflight CSS reset) — no Shadow DOM, no iframe. The only `<iframe>` in the
survey package is for embedding media inside a question
(`packages/surveys/src/components/general/element-media.tsx:56`), not for widget sandboxing.
This means the widget is exposed to host-page CSS bleed and global-namespace collisions; anyone
porting an embeddable survey/feedback widget should not assume this repo solved isolation.

### 5. Next.js Edge Middleware is conspicuously absent; auth/domain routing is pushed to infra
There is no `middleware.ts` at the app root. Domain-based routing (public survey-link domain vs.
authenticated admin domain) and route classification instead live in plain lib functions
(`apps/web/app/middleware/{route-config,endpoint-validator,domain-utils}.ts`) that are called
from inside route handlers, and there are dedicated internal auth-relay endpoints —
`apps/web/app/api/(internal)/envoy-auth/[...path]/route.ts` and a parallel `traefik-auth/` —
that exist specifically to be called back by an Envoy or Traefik reverse-proxy doing
forward-auth at the edge. This is a deliberate infra choice (push auth/rate-limit enforcement to
a proxy sidecar rather than in-process middleware,
`apps/web/modules/core/rate-limit/envoy-rate-limit-coverage.ts`), but it means the app alone is
not a complete authorization boundary for a self-hoster who skips the reverse-proxy layer —
worth flagging rather than assuming Next middleware is doing this work.

### 6. `Response` has no normalized answer storage
All response payloads are opaque JSON (`Response.data`, `.variables`, `.ttc`, `.meta`,
`.contactAttributes` — `schema.prisma:158-198`). Every analytics/summary view
(`getElementSummary`, cognitive 229, 8 linear-scans-in-loop,
`apps/web/app/(app)/workspaces/[workspaceId]/surveys/[surveyId]/(analysis)/summary/lib/
surveySummary.ts`) recomputes aggregates by deserializing and scanning JSON rather than querying
normalized columns — fine at Formbricks' current scale, a real cost if response volume grows by
an order of magnitude.

## Two-tool cross-check (cbm vs. graphify)

cbm: 17,895 nodes / 49,039 edges. graphify: 15,792 nodes / 40,868 edges, 827 communities (713
shown, 114 thin omitted), **99% EXTRACTED / 1% INFERRED / 0% AMBIGUOUS** — cleaner than
Chatwoot's 92/8, on par with Dittofeed's 99/1.

- **Agree:** `TSurvey` / survey-shape validation is the structural and complexity center of the
  repo (graphify god node #1 at 387 edges; cbm's top-4 complexity hotspots all validate `TSurvey`).
  Both tools also surface `logger` as a top hub (graphify #2, 275 edges; cbm fan-in analog).
- **cbm added:** cognitive/loop complexity metrics (confirmed **non-zero on this TypeScript
  target** — 3,306 of ~5,660 functions have nonzero cognitive complexity; `validateConditions`
  at 569 is the ceiling), Leiden clusters with real cohesion (0.565–0.944 across the 12
  reported apps/packages clusters — `database`, `email`, `i18n-utils`, `js-core`, `surveys`,
  `types` all self-identify as high-fan-in "core" layers via `get_architecture(aspects:
  ["layers"])`), and full-text/semantic code search.
- **graphify added:** import-cycle detection and betweenness. Cycle detection found **zero
  multi-file cycles** — every reported cycle is a 1-file self-reference, and unusually, every one
  of those self-cycles is a Next.js special file (`page.tsx`, `loading.tsx`) — see Tool
  Calibration below for why this is very likely a Next.js-App-Router-specific extractor artifact,
  not evidence of real self-imports. Community cohesion without the LLM labeling pass is again
  weak (large communities in the 0.02–0.03 range), matching the pattern already seen on Chatwoot —
  cbm's Leiden clusters remain the ones to read for "what are the real modules here."
- **Both produced noise a careless read would repeat:** graphify's isolated-node list (5,788 of
  15,792 nodes, 36.6%) is dominated by JSON/YAML config keys (`$schema`, `access`, `baseBranch`,
  `changelog`, `commit`) from `.changeset/config.json`, `devcontainer.json`, etc. — the same
  manifest-key pollution seen as god-nodes on Chatwoot/Mautic, here manifesting as noise in the
  *isolated*-node count instead of the top-degree list. Graphify's own top-10 god-node list, for
  what it's worth, was **clean this time** — no `package.json` dependency keys in it at all
  (`TSurvey`, `logger`, `Button`, `TUserLocale`, `getTranslate()`, `DatabaseError`,
  `ResourceNotFoundError`, `validateInputs()`, `ZId`, `TSurveyElementTypeEnum` — all real
  domain/infra symbols).

### Tool calibration (carry these into the remaining repos)

1. **cbm `Route` nodes do not work on Next.js App Router file-based routing — confirmed, and this
   is worse than either the Rails or the Fastify case.** `MATCH (r:Route) RETURN r.method,
   r.path, r.file_path, r.handler` returns 25 nodes total, and none of them are usable: most have
   every field empty (`method="", path="", file_path="", handler=""`); two carry `method="POST"`
   with no path/file/handler at all; and several were extracted not from route handlers but from
   **YAML config files** (`openapi.yml`, `docker-compose.yml`, `charts/formbricks/Chart.yaml`,
   `.github/ISSUE_TEMPLATE/config.yml`) whose key/value lines were misidentified as route
   declarations. cbm's Route extractor evidently looks for an explicit registration DSL
   (`app.get(path, handler)`-style, or YAML endpoint declarations) and has **no model at all**
   for Next.js's convention of exported `GET`/`POST`/etc. functions inside a file named
   `route.ts`. **Verify per-framework, not per-tool, every time** — three different repos, three
   different outcomes (Rails: present but 93% empty; Fastify: clean; Next.js App Router: broken
   and noise-contaminated).
2. **cbm loop/complexity metrics are populated and trustworthy on this TypeScript target** —
   consistent with the Dittofeed finding that the metric gap is per-language (Ruby: empty),
   not per-repo. Re-confirmed rather than assumed.
3. **graphify's cycle detector produces framework-specific false positives on Next.js App
   Router.** Every "cycle" it reported is a same-named special file (`page.tsx`/`loading.tsx`)
   "importing itself" — but Next.js conventions do not self-import these files, and dozens of
   distinct files across different route segments share these generic basenames. This reads as
   the extractor's cycle logic collapsing on basename rather than full resolved path in some
   step. Treat any graphify cycle report on a Next.js App Router repo as **needing basename-vs.
   -full-path verification before quoting**, not as a real cycle by default.
4. **graphify's god-node list was clean here (no manifest-key pollution in the top 10), but its
   isolated-node list absorbed the same pollution instead** — 5,788 of 15,792 nodes are `≤1`
   degree, and the sample given (`$schema`, `access`, `baseBranch`, `changelog`, `commit`) is
   entirely config/JSON keys, not real code symbols. The manifest-parsing noise moves around
   depending on the tool and the repo; check both ends of the degree distribution, not just the
   top.
5. **`toInteger()` alias-projection trap reconfirmed, third repo running.** `RETURN
   toInteger(f.cognitive) AS cog … ORDER BY cog DESC` works; a bare `WHERE toInteger(f.cognitive)
   > 0` raised `unexpected operator at pos 34` (function calls unsupported in `WHERE`, per the
   already-known trap) and had to be rewritten as `WHERE f.cognitive IS NOT NULL AND f.cognitive
   <> '0'` — string comparison against the string-typed property, not integer comparison.
6. **Cost/time:** cbm `moderate` index ≈ 1 minute (17,895 nodes). graphify ≈ 12+ minutes wall
   clock in this run — markedly slower than Chatwoot (~2 min) or Dittofeed (~3 min) for a
   comparably-sized repo, because five other repos' `graphify update` processes were running
   concurrently on the same machine during this run and visibly starved it for CPU (`ps` showed
   5 concurrent `graphify` python processes). **Not a Formbricks-specific slowdown** — note the
   concurrency, don't conclude graphify itself regressed.

## HTTP/API surface

Four generations of public API coexist: **v1** (14 management routes, session-or-API-key auth via
a shared `withV1ApiWrapper`), **v2** (23 management routes, the current primary surface — orgs,
roles, `/me`), **v3** (9 routes — `surveys`, `action-classes`, `contact-attribute-keys`,
`feedbackRecords`, `gateway`; the newest, RFC-9457-`problem+json`-flavored layer per
`with-api-logging.ts:49-53`), and the **client API** (`/api/v1/client/[workspaceId]/{environment,
user,responses,displays,storage}` — what the embedded SDK actually talks to, rate-limited by IP
via `applyIPRateLimit`). Auth methods: session cookie, `ApiKey`/`ApiKeyWorkspace` (scoped
`read`/`write`/`manage` per workspace, `schema.prisma:757-802`), or nothing (the client API is
intentionally public — it's what an anonymous website visitor's browser calls). Rate limiting is
split between the app (`apps/web/modules/core/rate-limit/`) and an edge Envoy proxy, with an
explicit coverage registry (`envoy-rate-limit-coverage.ts`) to avoid double-limiting the same
route at both layers. **Unauthenticated by design and worth flagging:** `/api/v1/client/*`
(environment sync, response/display submission) — this is correct for a survey-collection SDK,
but any code lifted from this surface must not be mistaken for an authenticated-by-default
pattern.

## Survey response ingestion, traced end to end

1. **SDK boot** (`packages/js-core`): `formbricks.setup()` fetches
   `/api/v1/client/[workspaceId]/environment` (cached: `s-maxage=60, stale-while-revalidate=60`),
   receiving a sanitized `WorkspaceStateData` — surveys (max 30, `status: inProgress`, `type:
   app`), action classes, workspace styling. Segment filters are **not** included; only
   `{id, hasFilters}` (`environment/lib/data.ts:35-241`).
2. **Trigger evaluation is 100% client-side.** No-code action listeners (page view, click, exit
   intent, scroll, time-on-page — `no-code-action.ts`) and `formbricks.track()` calls both funnel
   through `trackAction` (`js-core/src/lib/survey/action.ts:14-42`), which iterates the
   SDK-local `filteredSurveys` list and checks `trigger.actionClass.name === name`.
3. **Display gating** (`filterSurveys` in `lib/common/utils.ts`, called from `js-core`) applies
   `displayOption` (once/multiple/some/respondMultiple), `recontactDays`, `displayLimit`,
   `displayPercentage` (a client-side coin-flip, `shouldDisplayBasedOnPercentage`), and language
   availability — all evaluated against locally-cached `user.data.displays`/`.responses` state,
   **no additional network round-trip** before rendering.
4. **Widget render**: `renderWidget` (`widget.ts:49-199`) lazy-loads a separate script,
   `${appUrl}/js/surveys.umd.cjs` (the `packages/surveys` Preact bundle), waits for
   `window.formbricksSurveys` to appear (polled, 10s timeout), then calls `renderSurvey(...)`
   with the survey JSON, styling, and callbacks. The survey renders directly into a plain
   `<div id="fbjs">` — no iframe, no Shadow DOM (see Weakness #4).
5. **Submission**: `POST /api/v1/client/[workspaceId]/responses` — Zod-validated
   (`ZResponseInput`), single-use-token checked, file uploads validated, then
   `createResponseWithQuotaEvaluation` runs the **insert and the EE quota check inside one
   Postgres `$transaction`** (`responses/lib/response.ts:34-52`) — this is the
   synchronous/durable part. On success, `sendToPipeline` enqueues a BullMQ job for
   `responseCreated` (and `responseFinished` if `finished: true`) — this is the **deferred**
   part: webhooks, Zapier/Sheets/Notion/Slack integrations, follow-up emails, notification
   emails, Stripe usage metering, PostHog capture, and survey auto-complete-on-threshold all
   happen after the HTTP response has already returned to the browser
   (`process-response-pipeline-job.ts:756-827`).
6. **Guarantees against loss/duplication:** the response row itself is guaranteed by the DB
   transaction (survives even if the BullMQ enqueue subsequently fails — `sendToPipeline` throws
   and is logged, but the response already committed). Duplicate-submission protection is a
   unique constraint on `(surveyId, singleUseId)` (`schema.prisma:196`) plus a `displayId`
   uniqueness constraint, not an idempotency key on the request itself. Webhook delivery loss is
   bounded by BullMQ's `attempts: 3` with configured backoff (`packages/jobs/src/
  constants.ts:28-29`); once retries are exhausted the failure is logged and the rest of the
  pipeline (integrations, emails) still runs — a single dead webhook does not block a survey's
  other side effects (`process-response-pipeline-job.ts:307-322`).

## Targeting / audience logic

Two independent mechanisms, one free and shallow, one paid and real:

- **`SurveyAttributeFilter`** (core schema, `schema.prisma:290-305`): one `equals`/`notEquals`
  comparison against one `ContactAttributeKey`, attached directly to a survey. No boolean
  composition, no nesting. Available regardless of license — but since creating a `Contact` at
  all requires the EE-gated identify call (below), this filter is only reachable in practice on
  a licensed instance too.
- **`Segment`** (core schema for storage, `schema.prisma:960-973`; **EE for everything else**):
  `filters` is a JSON tree (`TBaseFilters`, `packages/types/segment.ts:285-401`) of nested
  AND/OR groups over four filter kinds — `attribute` (contact attribute + one of ~14 operators
  including relative/absolute date comparisons), `person` (userId string ops), `segment`
  (nested "user is in segment X"), `device` (phone/desktop). Evaluation is **server-side and
  authoritative**: `evaluateSegment` (`apps/web/modules/ee/contacts/segments/lib/segments.ts:
  602-701`) recursively resolves AND-before-OR precedence in-memory for ad-hoc checks, while the
  hot path — `getPersonSegmentIds` (`.../user/lib/segments.ts:40-104`) — instead **compiles each
  segment's filter tree into a Prisma `WHERE` clause** (`segmentFilterToPrismaQuery`) and runs
  membership as a single SQL query per segment, batched into one transaction per identify call.
  This is genuinely server-side targeting with no client-trust exposure — the earlier
  `hasFilters`-only sanitization (see What's Good) is what makes that true in practice, not just
  in the evaluator's location.
- **Gate:** all of the above (identify call, segment CRUD, segment evaluation) is reachable only
  through `apps/web/modules/ee/contacts/`, and the identify endpoint 403s with "enterprise users"
  messaging when `getIsContactsEnabled(organizationId)` is false. **Client-side trust
  implication: none for a licensed instance** (targeting decisions never leave the server in a
  form a visitor could read); **the implication for an unlicensed self-hosted instance is that
  attribute/segment targeting simply doesn't exist**, not that it's insecure.

## The widget/SDK

`packages/js-core` (MIT, Vite build, UMD + ESM outputs) is the always-loaded boot script; it
holds config/state management (`lib/common/config.ts`, a versioned localStorage-backed store),
the command queue (serializes async SDK calls), trigger listeners, and user-identification
plumbing (`lib/user/update-queue.ts` — batches/dedupes `setAttribute` calls). It does **not**
contain the survey renderer. On first trigger match, it dynamically injects
`<script src="${appUrl}/js/surveys.umd.cjs">` — `packages/surveys`, a separate MIT/Preact bundle
— and communicates via a single global (`window.formbricksSurveys`), not postMessage/iframe
boundaries. **Versioning:** both packages ship from the same monorepo release, so there's no
independent SDK-vs-app version skew story visible in-repo; **backward compatibility for the wire
protocol is handled explicitly** — `environment/lib/data.ts:141-205` maintains placeholder
fields (`survey.name`, full `segment` shape) specifically so pre-PR-#7931 SDKs that decoded those
as required fields keep working, while the real (sensitive) values are replaced with
placeholders. **Isolation on a host page: weak** — no Shadow DOM, no iframe (see Weakness #4); a
CSS preflight reset under `#fbjs` is the only defense against host-page style bleed.

## Triggers and actions

`ActionClass` (`type: code | noCode`) is the trigger vocabulary; `SurveyTrigger` links a survey to
one or more action classes (`schema.prisma:264-275`). No-code action sub-types
(`noCodeConfig.type`) cover `pageView`, `click` (CSS-selector or inner-text match,
`evaluateNoCodeConfigClick`), `exitIntent`, `fiftyPercentScroll`, `pageDwell` (time-on-page,
per-page timers that reset on navigation) — all in `packages/js-core/src/lib/survey/
no-code-action.ts`, all URL-filterable with AND/OR connectors. Code actions are looked up by a
`key` string via `formbricks.track(code)` (`js-core/src/lib/survey/action.ts:50-73`). **Response
-triggered automation** is limited to what `process-response-pipeline-job.ts` runs on
`responseFinished`: follow-up emails (`SurveyFollowUp`, a separate scheduled-send model),
integration dispatch, notification emails to org members with alerts enabled for that survey, and
auto-completing the survey once `autoComplete` response count is reached
(`handleSurveyAutoCompleteSafely:538-616`). There is no cross-survey or multi-step automation —
each survey's triggers and each response's side effects are independent, single-hop events; there
is nothing resembling a journey/sequence engine anywhere in this repo.

## Integrations/webhooks

- **Webhooks** (`Webhook` model, sources `user`/`zapier`/`make`/`n8n`/`activepieces`): delivered
  from the BullMQ pipeline job (see Ingestion §5) with Standard-Webhooks-spec signing, DNS-pinned
  fetch, manual-redirect SSRF blocking, and a 5-second timeout
  (`process-response-pipeline-job.ts:26,129-283`). Delivery is per-webhook `Promise.allSettled`
  (`deliverWebhooks:285-323`) so one failing webhook doesn't block others in the same job;
  job-level retry (BullMQ `attempts: 3` + backoff) covers transient failures, and once retries
  are exhausted the failure is logged and the rest of the pipeline proceeds.
- **First-party integrations** (`IntegrationType`: googleSheets, notion, airtable, slack) are
  dispatched via `handleIntegrations` (called only on `responseFinished`,
  `process-response-pipeline-job.ts:644-656`), each wrapped in its own try/catch so one
  integration's failure doesn't block webhooks or emails.
- **Feedback-source pipeline** (`handleFeedbackSourcePipeline`, EE) is a separate fan-out for the
  `feedback-directory`/`unify-feedback` EE modules — response data flows into an external
  "feedback source" mapping layer; treated here as out-of-scope detail (EE, low port relevance).

## Multi-tenancy and data isolation

`Organization → Workspace → {Survey, Contact, ActionClass, Segment, Webhook, Tag, Integration,
FeedbackSource}` — every tenant-scoped model carries a direct `workspaceId` foreign key with
`onDelete: Cascade` (`schema.prisma`, throughout), and `Workspace` itself cascades from
`Organization`. There is **no row-level security in Postgres** — isolation is enforced entirely
in application code via `getOrganizationIdFromWorkspaceId` + membership/role checks
(`OrganizationRole`: owner/manager/member/billing) called at the top of server actions and API
route handlers. `ApiKeyWorkspace` provides per-key, per-workspace, per-permission scoping
independent of user sessions. **Domain-level separation** is a second, orthogonal boundary:
`PUBLIC_URL` (survey-taking, `/s/[surveyId]`, `/p/[slug]`) vs. the admin domain
(`WEBAPP_URL`) are distinguished by `isPublicDomainRoute`/`isAdminDomainRoute`
(`app/middleware/endpoint-validator.ts:53-83`), enforced not by Next.js Edge Middleware (there
is none) but by dedicated internal endpoints designed to be called from an Envoy or Traefik
reverse-proxy doing forward-auth (`app/api/(internal)/{envoy-auth,traefik-auth}/`) — see Weakness
#5. As established under Targeting, the removal of the `Environment` model
(prod/dev split within a project) means the tenancy hierarchy is now exactly two levels
(Organization, Workspace) rather than the historical three (Organization, Project, Environment).

## Data model

Prisma/Postgres, 1,318-line `schema.prisma`, 177 migrations (`packages/database/migration/`,
oldest `20230329205933_init`), pgvector extension enabled (`schema.prisma:6` — used by the
`ai`/`ai-translation` EE modules, not by core survey logic). Key JSON columns and what they hold:
`Survey.{questions,blocks,endings,welcomeCard,hiddenFields,variables,styling,workspaceOverwrites,
singleUse,recaptcha,metadata}` (survey definition + per-survey overrides, all opaque JSON);
`Response.{data,variables,ttc,meta,contactAttributes}` (answer payload + timing + device/geo
metadata, opaque JSON, see Weakness #6); `Segment.filters` (the `TBaseFilters` tree, see
Targeting); `Workspace.{styling,config}` and `Organization.{whitelabel,billing}` (tenant-level
JSON config, prisma-json-types-generator gives these actual TS types via `/// [TypeName]`
doc-comment annotations — a nice lightweight alternative to a full JSON-schema column). Indexes
are sparse and purpose-built rather than exhaustive: `Response` has exactly three
(`createdAt`; `(surveyId, createdAt)`; `(contactId, createdAt)`) explicitly commented as existing
"to determine monthly response/identified-user count" — i.e. added for a specific billing-metering
query, not general-purpose.

## Next.js architecture specifics

- **Dual mutation surface, cleanly split by audience.** 65 files under `apps/web/{modules,app}`
  use `"use server"` (Next.js Server Actions) — these back the authenticated dashboard UI
  directly from React components, no REST hop. The public-facing SDK, third-party API
  consumers, and Zapier/webhook-style integrations instead go through versioned REST
  `route.ts` handlers (`v1`/`v2`/`v3`/`client`) with a shared auth/rate-limit/audit wrapper
  (`withV1ApiWrapper`, `app/lib/api/with-api-logging.ts`). **Worth adopting**: this split is the
  right default for a Next.js app that has both a first-party UI and a real public API surface —
  don't route dashboard mutations through `fetch` to your own REST API when a server action is
  available, but do keep a REST surface for anything a third party or an SDK needs to call.
- **Route-group organization by concern, not by URL shape**: `app/(app)/`, `app/(auth)/`,
  `app/(redirects)/` group authenticated-app pages, auth pages, and legacy-URL redirect shims
  respectively, without affecting the URL. `app/(app)/(onboarding)/` and
  `app/(app)/(survey-editor)/` further nest route groups for onboarding and the survey builder —
  a real, working example of route groups as an organizational tool rather than a routing
  mechanism. **Worth adopting.**
- **`apps/web/modules/<feature>/{lib,components,api,types}` as the shared-logic boundary**,
  imported by *both* the thin `app/` route files and the `route.ts` API handlers. `app/` stays
  nearly empty (import + re-export, e.g. `app/api/v1/client/[workspaceId]/user/route.ts:1-3`
  literally re-exports from `modules/ee/contacts/api/...`), and all real logic lives in
  `modules/`. **Worth adopting** — it's the cleanest way we've seen across the surveyed repos to
  keep Next's file-based routing constraints from forcing business logic into route files.
- **No Edge Middleware, auth pushed to a proxy layer** (see Weakness #5). **Anti-pattern to note,
  not necessarily to avoid**: if Open Marketing ships without a mandatory reverse-proxy in front
  of it (e.g. a simpler self-host story, or the Electron packaging where there's no proxy at
  all), this specific pattern doesn't transfer — Electron in particular has no Envoy/Traefik
  sidecar, so whatever auth boundary we build must not assume one exists.
- **Registry/override pattern for cross-package job handlers**: `packages/jobs` defines a generic
  `JobHandler` contract and a stub processor that throws if unregistered
  (`packages/jobs/src/processors/response-pipeline.ts:5-23`); `apps/web` registers the real
  implementation at boot. This avoids a circular dependency (`jobs` would otherwise need to
  import from `web` to know what a "response pipeline job" does) while keeping the queue
  infrastructure package-agnostic. **Worth adopting** for any generic background-job package that
  needs app-specific handlers.

## Reimplementation notes (port / adapt / skip)

1. **Webhook delivery pipeline (SSRF-hardened, Standard-Webhooks-signed, BullMQ-retried)** —
   **port closely.** This is the single highest-value near-as-is lift in the repo: DNS-pinned
   dispatcher, manual-redirect blocking, signature scheme, and the `Promise.allSettled` +
   job-level-retry structure are all stack-compatible (Next.js/TypeScript/BullMQ-or-equivalent)
   and represent real security engineering worth not re-deriving. `process-response-pipeline-
   job.ts:129-283`.
2. **EE license-check pattern (network-verified, cached, graceful degradation)** — **port the
   shape**, not the Formbricks-specific endpoint. The 24h-cache / 3-day-grace-period / per-
   feature-flag structure (`license.ts:26-61`, `license-check/lib/utils.ts`) is a clean template
   for any product that needs a real (not directory-presence) self-hosted licensing gate.
3. **Trigger taxonomy (page view / click / exit intent / scroll / time-on-page / code action)**
   — **port closely.** It's a complete, working, portable event vocabulary for "when should we
   show something," independent of the survey domain — directly reusable for any in-product
   prompt/nudge/survey feature we build.
4. **Segment JSON-filter shape (nested AND/OR, attribute/person/segment/device resource types,
   ~14 operators including relative dates)** — **adapt, don't port.** The shape
   (`packages/types/segment.ts:285-401`) is a reasonable reference for a targeting-rule schema,
   but the evaluator is EE-only source (can't copy verbatim) and is duplicated even within this
   repo (see Weakness #2) — a sign the abstraction itself isn't stable enough to transliterate.
   Rebuild the evaluator ourselves using this as a shape reference only.
5. **Public-API sanitization pattern (typed "safe" projection of a sensitive resource,
   `ZJsWorkspaceStateSegment`)** — **port the pattern.** Any endpoint an anonymous client can
   call that touches targeting/audience data should have an explicit, typed, minimal public
   shape like this one, with the real evaluation kept server-side. Directly applicable to
   whatever public tracking/identify endpoint Open Marketing ships.
6. **Widget/SDK split (small always-loaded boot script + lazy-loaded Preact renderer, single
   global-object bridge)** — **adapt.** The bundle-size discipline (Preact for the on-demand
   piece) is worth copying; the no-Shadow-DOM/no-iframe isolation choice is worth explicitly
   *not* copying if we ship an embeddable widget on arbitrary third-party pages — Shadow DOM or
   iframe isolation should be a deliberate improvement over this reference, not an oversight.
7. **`app/` -as-thin-re-export + `modules/<feature>/{lib,components,api,types}`** — **port the
   organizational pattern.** This is the cleanest Next.js App Router code-organization approach
   seen in this survey and works well with server actions, route handlers, and shared logic all
   drawing from the same `modules/` tree.
8. **Quota engine (`SurveyQuota`/`ResponseQuotaLink`, transactional evaluation alongside response
   insert)** — **adapt.** The "evaluate inside the same DB transaction as the write" pattern is
   worth keeping regardless of domain; the specific quota-condition matching logic is EE source
   and secondary in value.
9. **Skip entirely:** `apps/web/modules/ee/*` wholesale (license — 79,548 LOC, including
   contacts/segments/SSO/2FA/audit-logs/billing/whitelabel/feedback-directory/dashboards/quotas),
   the survey question-type editor UI (Formbricks-specific, not marketing-automation-relevant),
   the AI-translation/AI-smart-tools modules (thin wrappers, EE-gated, low novelty), and the
   `migrate-to-v4` package (one-time upgrade tooling, no reusable logic).
10. **Do not expect from this repo:** a journey/sequence engine, an email-lifecycle/broadcast
    system, or a segment engine with anything beyond survey-targeting scope. Source those from
    Dittofeed (journeys + incremental segment compute) and Mautic (segment QueryBuilder) as
    already noted in those analyses; Formbricks' contribution to Open Marketing is the
    **in-product-prompt trigger/delivery/webhook layer**, not the audience/journey layer.

## Reproducing / refreshing this analysis

- **graphify** (`$0`, no LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/formbricks && graphify update .` — do **not**
  pass `--no-viz` to `update` (not a valid option there, exits 2; the HTML viz auto-skips above
  5,000 nodes anyway). This run wrote to
  `/Users/la/Programming/Tovu/AI-Dev-Shop/ADS-memory/reports/graphify-out/formbricks-2d25f9e5/`
  (`graph.json`, `GRAPH_REPORT.md`, `manifest.json`) at commit `c6f9af98`. Re-run took ~12 minutes
  in this session due to five other repos' `graphify update` running concurrently — expect faster
  in isolation.
- **codebase-memory-mcp:** project `formbricks`, indexed 2026-09-06 in `moderate` mode at commit
  `c6f9af98` (17,895 nodes / 49,039 edges). Use `get_architecture`, `search_graph`, `query_graph`,
  `get_code_snippet`. Cypher notes (reconfirmed on this repo): numeric properties are
  string-typed — project through `toInteger()` and sort on the **alias**
  (`RETURN toInteger(f.cognitive) AS cog … ORDER BY cog DESC`), never on a repeated function call
  in `ORDER BY` (silently ignored); function calls are unsupported in `WHERE` — filter with a
  string comparison (`WHERE f.cognitive <> '0'`) instead.

## Handoff

**Inputs used:** direct source reads across `packages/database/schema.prisma`, the client API
route tree (`app/api/v1/client/[workspaceId]/**`), the response pipeline
(`modules/response-pipeline/**`, `packages/jobs/**`), the SDK (`packages/js-core/src/**`), the
EE license/contacts/segments modules, root `LICENSE` + `apps/web/modules/ee/LICENSE`, and all
`package.json` license fields under `packages/`; cbm `get_architecture`/`search_graph`/
`query_graph`/`search_code`; graphify's `GRAPH_REPORT.md` and `manifest.json`.

**Output:** `/Users/la/Programming/Open-Marketing/docs/formbricks-architecture.md` (this file).

**Risks/uncertainties:** the licensing analysis is a good-faith legal *reading*, not legal
advice — the package.json-vs-root-LICENSE inconsistency documented above should be treated as a
flag for actual counsel before any code is lifted, not a resolved question. Formbricks Cloud
-specific behavior (Stripe entitlement enforcement, `IS_FORMBRICKS_CLOUD` branches) is inferred
from source only; no live Cloud instance was inspected. The webhook/pipeline security analysis is
based on reading `process-response-pipeline-job.ts` and its imports; the SSRF-validation helper
itself (`lib/utils/validate-webhook-url.ts`) was referenced but not read function-by-function —
worth a deeper pass if this pattern is actually ported.

**Suggested next assignee:** whoever ports the webhook-delivery pattern (item 1 above) should
read `apps/web/lib/utils/validate-webhook-url.ts` in full before implementation — it wasn't fully
inlined here but is the other half of the SSRF story (URL validation) alongside the dispatcher
pinning documented in this doc.

**What I could not verify:** production request volume/latency; whether `packages/api`,
`packages/android`, `packages/ios` exist in a different Formbricks repo (they are absent from
this clone, full stop); the exact BullMQ backoff *strategy* (fixed vs. exponential — confirmed
`attempts: 3` and a `backoff` config reference exists at `packages/jobs/src/constants.ts:28-29`,
but the backoff shape itself wasn't read in detail); live behavior of the
`ee.formbricks.com/api/licenses/check` endpoint (cannot reach or test it from this environment).

**Does cbm's `Route` node work on Next.js file-based routing?** **No.** Confirmed by direct
Cypher query: 25 Route nodes total, effectively all empty (`method`/`path`/`file_path`/`handler`
blank) or contaminated by YAML config files misread as routes. This is a worse outcome than
either the Rails DSL case (93% empty but structurally present) or the Fastify case (clean) from
the two prior analyses — cbm's Route extractor has no model of Next.js App Router's
exported-HTTP-verb-function-in-`route.ts` convention at all.
