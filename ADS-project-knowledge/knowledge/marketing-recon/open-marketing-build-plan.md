# Open Marketing — Build Plan

An open-source marketing platform on the Jini agent runtime: paid acquisition, lifecycle
messaging, AI creative production and analytics — as one product with three engines.

**Architects:** GPT-6-Astra · Opus 5 · Fable 5.1 · Gemini 3.1 Pro · Gemini 3.8 Flash
(five independent reviews against one brief; disagreements listed rather than averaged)

Claims marked **[source-verified]** were checked against the Jini source rather than package
documentation. Two architects revised their own designs after doing so.

---

## The verdict: one product, three engines

All five architects independently concluded this is **one product, not three**, because of a
single loop:

```
ad → landing page → subject_identifier → journey → purchase → conversion export → better ads
```

You spend money to convert an anonymous click into a row in `subject_identifier`, then earn it
back over years through channels that cost almost nothing per send. The same hashed email
uploaded to Meta as a lookalike seed is the one your journey sends to, and the same `consent`
row governs both. Split them into separate products and identity, consent and attribution must
cross a network boundary — you would be shipping the reconciliation problem as a feature.

But **"one product" is not "one engine."** Three loops have different physics and must never be
fused:

| Engine | Physics |
|---|---|
| **Journey poller** | Time-driven, discrete, idempotent, retry-safe. `journey_run` with `resume_at`, claimed via `FOR UPDATE SKIP LOCKED`. |
| **Pacing poller** | Money-driven, continuous, irrecoverable. Must survive our own death — the platform keeps charging while our process is down. |
| **Generation poller** | Vendor-driven, slow, non-deterministic. Leased with absolute deadlines; a retry costs real money per call. |

Three loops, one spine, one repo, one `subject`. No Temporal, no workflow VM, no process
checkpointing — a finite graph of known steps needs a table and a poller.

---

## What Jini already gives you

### `@jini-ai/integrations/media-providers` — use it **[source-verified]**

Async creative generation is **mostly already solved**. `dispatch/polling-adapter.ts` defines a
`PollingVendorAdapter` submit-then-poll tier for "a vendor that hands back a job handle and makes
you come back for the result." Behind it, `dispatch/async-operation-store.ts` is a durable row
carrying `attempts`, `nextPollAt`, a worker `lease` and an absolute `deadlineAt`;
`reconcileOnBoot` releases leases rather than killing work, and `submitIsIdempotent` defaults to
`false` because "media generation costs real money per call, so a retry must be proven safe, not
assumed."

Verified independently, with mechanics: `startOperation` persists *before* the first HTTP call,
`pollDueOperations` is a leased tick using a single `UPDATE…RETURNING` claim, `recoverAfterRestart`
releases leases and routes non-idempotent crashed submits to `unknown`, and `now` is injectable.

The credential seam is worth copying outright: polling builders **never receive credentials**.
They build an unsigned request and a `RequestSigner` attaches auth on every tick, so a token
expiring mid-poll is a non-event, and the durable row is validated on write to reject credential
material.

**What you add — small and countable.** The catalogue ships no Higgsfield, Seedance, Kling,
Runway, Luma, Veo, Sora or Pika; only one polling adapter is registered; and the package
deliberately provides *no scheduler and only a SQLite durable adapter*. So Open Marketing supplies
four things:

1. One host tick
2. A ~200-line Postgres `AsyncOperationStore`
3. A `PollingVendorAdapter` each for Seedance and Higgsfield
4. A `creative_job` metadata row

Everything else — poll loop, lease fencing, deadlines, signer — is inherited. *A week, not a quarter.*

### `@jini-ai/mcp` — build the boundary yourself **[source-verified]**

It gives you **no trust boundary** for third-party MCP servers. `src/client/client.ts` exports no
`callTool` and no `listTools` — only an idle-exit controller and two mime helpers. The `server/`
tree is Jini acting as an MCP *server*, the opposite direction from your problem. "Sanitize" in
`core/config.ts` means `mcp.json` shape validation, not tool-result handling; there is no
redaction, output bounding, allowlisting or tainting, and tokens are stored per server rather
than per tool.

Confirmed independently, with two sharpening findings: **no package in the engine imports
`@modelcontextprotocol/sdk/client`** — there is no MCP client anywhere in Jini — and
`McpServerConfig` has no tool allowlist field. Most consequentially, `agent-install` wires MCP
servers into the coding agent's *own* config, so those tool calls **bypass `ToolExecutor`
entirely** and never meet your risk tiers. Any third-party server that matters must be brokered,
not installed.

**The pattern to generalize lives elsewhere:** `@jini-ai/integrations/composio`'s
`output-protection.ts` bounds third-party output at `CONNECTOR_MAX_OUTPUT_BYTES = 256 * 1024`
with `maxDepth: 32`, `maxNodes: 25_000` and a `[redacted]` secret pass.

### Three packages that are not what their names suggest **[source-verified]**

- `@jini-ai/tokens` is **CSS design tokens** — "one set of CSS custom-property names" — not a secrets store.
- `@jini-ai/artifacts` is `create`/`get`/`list` over a manifest with no versions, variants, rights or lineage, so it **cannot serve as the asset library**.
- `@jini-ai/capability-providers`' `DbProvider` is a record store, so a delivery ledger needing joins and row locks must not go through it.

Useful and easy to miss: `@jini-ai/platform`'s `blob-storage.ts` (with `aws-sigv4.ts`) gives Local
and S3 blob storage for asset bytes, and `assertExternalAssetUrl` is a real SSRF guard that
resolves hostnames through DNS and checks the *resolved addresses* against private ranges —
defeating DNS rebinding, not just string matching. It matters because vendors hand back asset URLs
you then fetch.

---

## Every module you need

Legend: **NEW** = you write it · **JINI** = consumed from the engine · **EXTERNAL** = third-party service

### Spine — build this first

| Module | | Owns | Marketing job |
|---|---|---|---|
| `identity` | NEW | `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`. Kinds: `fbclid`, `gclid`, `ttclid`, `li_fat_id`, `anonymous_id`, `email`, `phone`, `sha256_email` | Recognizes one person across a click, a form and an email |
| `consent` | NEW | `consent`, `suppression`, all three gate functions in one file | The legal record of what this person agreed to, per purpose |
| `events` | NEW | `event` append store, `POST /v1/track`, browser snippet | Raw material for both segments and conversions |
| `erasure` | NEW | Deletion intake, cascade through rollups, **and outbound deletion to ad platforms** | "Delete me" must unpick data already sent to Meta, or the request is unfulfilled |
| `audit` | NEW | `audit_log` with principal `human \| agent:<runId> \| mcp:<serverId>` on every mutation | |
| `secrets` | NEW | Server-side encrypted vault. Never in Electron, never handed to an MCP server | |
| `om-clock` | NEW | The injectable `Clock`, threaded through all three pollers from commit one | |
| `om-pg` | NEW | Pool, migrations, `claimBatch()` over `FOR UPDATE SKIP LOCKED`. Jini ships no Postgres | |
| `om-outbox` | NEW | Idempotency-keyed outbound calls. Every platform write passes through | |
| `segments` | NEW | Versioned definitions, one condition→SQL compiler, evaluated live | "Who should get this" — reusable for email and ad audiences |
| `frequency-cap` | NEW | Shared counter at the send gate | Stops one person getting nine messages a week from four journeys |

### Lifecycle messaging

| Module | | Owns | Marketing job |
|---|---|---|---|
| `render` | NEW | One `render()` for preview, test-send and dispatch — preview is the same function with a mocked recipient | |
| `journeys` | NEW | Immutable `journey_version`, `journey_run`, `resume_at`/`wait_event`, one poller. Pin version at entry; never migrate in-flight runs | |
| `dispatcher` | NEW | `message_delivery` ledger, provider adapters, retry classification | Without a per-recipient ledger you can never answer "what did we send this person, and did it arrive" |
| `deliverability` | NEW | Per-domain acceptance, warm-up ramp, bounce/complaint intake, throttles | A new domain blasting 100k on day one gets blocked by Gmail for months. Zero prior art across twelve surveyed repos |
| `preferences` | NEW | Signed preference page; compliance in the base template | An email without a working unsubscribe is not sendable |

### The acquisition join — where paid becomes lifecycle

| Module | | Owns | Marketing job |
|---|---|---|---|
| `forms` | NEW | Hosted submit endpoint + embed snippet. Captures click id from the landing URL, writes `subject` + `subject_identifier` + `consent` in one transaction | The single moment a click becomes a person. This is why the funnel exists |
| `landing pages` | JINI + NEW | Built on `@jini-ai/cms` (entries, presentation, content-types, media, taxonomy have landed; **forms has not**) | Changing the page an ad points at is faster and cheaper than changing the ad |
| `web-tracker` | NEW | First-party `/collect` endpoint and JS snippet writing `event` rows with a first-party cookie and click ids | First-party data is the only kind ATT and cookie deprecation did not break |
| `links` | NEW | UTM construction, signed redirects, `touch` rows | |
| `publish` | JINI | `@jini-ai/devops/deploy`'s `DeployTarget` — Vercel, Cloudflare Pages, Netlify, GitHub Pages | |

### Paid media

| Module | | Owns | Marketing job |
|---|---|---|---|
| `ad-accounts` | NEW | OAuth connections, account health, suspension detection | |
| `campaign-plan` | NEW | `campaign`, `ad_set`, `ad`, `creative_binding` — your *desired* state, held separately from theirs | |
| `platform-sync` | NEW | Reconciler over desired vs platform-reported, `platform_drift` log, review-status polling | Ads sit in review for hours and get rejected without telling you. The reconciler is how you find out |
| `budget-ledger` | NEW | `budget_authorization`, `spend_ledger`, `pacing_plan` | |
| `spend-guard` | NEW | Burn-rate circuit breaker + `ad_account.halted_at` kill row | Stops a bad bid burning money overnight |
| `platform-audiences` | NEW | Custom/lookalike upload, SHA-256 normalized hashing, gated on `shareability()` | Seeding the platform with your best customers is the highest-leverage targeting lever that exists |
| `conversion-feed` | NEW | Meta CAPI, Google enhanced conversions, TikTok Events API. Sends hashed email/phone, click id, `event_name`, `event_time`, `value`, `currency`, `event_id` shared with the pixel for dedup | This is what makes the ad algorithm work at all — it learns who to target only from conversions you report back |
| `offline-conversions` | NEW | CRM and refund import so conversions can be retracted | Stops the algorithm optimizing toward buyers who charge back |
| Meta · Google · TikTok · LinkedIn | EXTERNAL | Marketing APIs. **Ship Meta only in v1** — the loop still closes | |

### Creative production — your differentiator

| Module | | Owns | Marketing job |
|---|---|---|---|
| `generation-jobs` | NEW | Thin binding only: `generation_job(async_operation_id, asset_id, campaign_intent, brand_kit_version, cost_cents)` | |
| `asset-library` | NEW | `asset`, `asset_version`, `asset_variant`, `rights_grant`, content-addressed blobs via `@jini-ai/platform` BlobStorage | |
| `provenance` | NEW | Prompt, model, seed, brand-kit version, cost, vendor terms per asset | Proves you may legally run this image, and lets you re-roll the one that worked |
| `variant-render` | NEW | Deterministic per-placement crops | One concept ships as 1:1, 4:5, 9:16, 16:9, 2:3 and 1.91:1 — or it cannot run |
| `creative-fatigue` | NEW | CTR decay vs rolling baseline, CPM drift per `ad`, replacement queue | The same image stops working in two to four weeks. This is the clock that says when |
| `brand-kit` | NEW | Palettes, lockups, forbidden claims — injected into every generation prompt | |
| `mcp-broker` | NEW | Connection manager, per-server tool allowlist, output bounding, taint tagging, pinned manifest digests | |
| Higgsfield · Seedance | EXTERNAL | Reached over MCP. Neither appears in the Jini media catalogue today | |

### Analytics

| Module | | Owns | Marketing job |
|---|---|---|---|
| `metric-snapshots` | NEW | `platform_metric_snapshot` keyed by `as_of` **and** `attribution_window`. Restatement-aware; never updated in place | |
| `attribution` | NEW | `touch` → `conversion` under one declared model | |
| `reconciliation` | NEW | The three-way diff screen | Where you go when the dashboard says 400 conversions and the bank says 250 |
| `commerce context` | NEW, **deferred** | Products, offers, orders, refunds, revenue, margin. Module defers — but reserve `conversion_event.value`, `currency` and an `order_id` identifier kind **now** | Without margin you can compute spend but never true ROAS or LTV |
| `holdout group` | NEW, **Phase 0** | A single global holdout. Full experimentation defers | The only honest referee between platform-claimed conversions and your ledger. Cannot be reconstructed later |

### Runtime and surfaces

| Module | | Owns |
|---|---|---|
| `apps/server` | NEW | Always-on, Docker-deployable. Owns all three pollers, all callbacks, all credentials |
| `apps/desktop` | NEW | Electron console over `@jini-ai/desktop-host`. Sidecar-launches the server in local mode only |
| `object-canvas` | NEW | Three panes — left nav, center canvas, right agent. Agent output lands as a `draft` row, never prose |
| `om` CLI | NEW | Every capability reachable from the terminal, including `om ads halt` and `om approve` |
| agent runtime | JINI | `protocol`, `daemon`, `agent-runtime`, `chat`, `agentic`, `http-kit`, `core`, `sqlite` (run events only — product data is Postgres) |
| `@jini-ai/approvals` | NEW | Durable `pending_decision` rows answerable from UI or CLI after the run dies. Product-neutral — contribute upstream |

---

## Three gates, not one

Adding paid media splits the single `sendability()` predicate into three, because these are
categorically different acts against the same `consent` table.

**`sendability(subject, channel, purpose, clock)`**
May we message this person? Called by both the estimator and the dispatcher — a mismatch between
them is a correctness bug, not an edge case.

**`shareability(subject, destination, purpose)`**
May we transmit this person to a third party? Uploading a hashed email to Meta is not messaging.
Suppression does *not* block it — an unsubscriber's purchase is still a valid optimization signal
— but consent withdrawal does.

**`spendability(ad_account, amount, window, clock)`**
May we spend this money now? A send is discrete and gate-able at the moment it happens. Spend is
a process you start and cannot stop from inside.

> ### First-commit tell
> `packages/spine/src/gates.ts` exports exactly these three functions, all taking `Clock`, and
> migration `0001_spine.sql` contains `subject_merge`, `consent` and `budget_authorization` in one
> file. **A second implementation of any gate appearing anywhere** — in the estimator, a UI hook,
> an ads adapter — means the plan has drifted and the two will silently disagree.

---

## The agent boundary: every gate is an envelope

An approval gate that fires hundreds of times a day trains the operator to rubber-stamp it, which
converts the safety mechanism into theater. One architect proposed holding durable gates to
exactly five as a design constraint; another agreed with the discipline but rejected the number as
an invariant. The better formulation: **every gate approves an envelope rather than an action, and
`ApprovalKind` is a closed enum** — five today, extended only deliberately.

`plan.publish` · `budget.envelope` · `identifiers.export` · `consent.increase` · `account.connect`

The asymmetry that makes this safe: **the agent may always stop spending, never start it.**
Pausing is never symmetric with resuming.

| Tool group | Representative calls | Tier |
|---|---|---|
| Reads & drafts | `spine.*` reads, `segments.estimate`, `segments.create_draft`, `assets.search`, `render.preview`, `reports.query`, `reconciliation.diff`, `ads.read_*`, `fatigue.status` | autonomous |
| Reducing risk | `ads.pause_*`, cancel a broadcast, add a suppression, add to do-not-contact | autonomous |
| Creative variants | `creative.generate_variants` — re-crops of an already-approved asset, no new concept | autonomous |
| Publishing definitions | `journeys.publish_version`, `templates.publish`, `pages.publish`, `forms.publish` | confirm-in-run |
| Costed generation | `creative.generate` above a per-run cost ceiling; `mcp.call` where the server's manifest digest changed | confirm-in-run |
| Launching spend | `campaign.launch` | **durable** |
| Exporting people | `audience.upload_to_platform` | **durable** |
| Enabling the feed | `conversions.enable_feed` — once per `(destination, event_type, consent_purpose)` | **durable** |
| Broadcast send | `send.execute` above N recipients | **durable** |
| Granting credentials | `connection.grant` | **durable** |

**Batching is what keeps the count low.** `campaign.launch` approves one `budget_authorization`
covering a three-week flight, every ad set beneath it, a `creative_set_digest` and a bid band.
Inside that envelope the agent reallocates between ad sets, rotates pre-approved creative and
moves bids within the band autonomously, hundreds of times, ungated. `creative.generate` is
approved as a *storyboard* — one gate for 24 renders across six ratios under a single cost
ceiling, not 24 gates. Raising a cap or adding a platform **re-opens the existing approval
object** so the operator reads a diff, rather than minting a fresh wall of text they will skim.

---

## Money: the irreversible boundary

An email is discrete, idempotency-keyed and gate-able at the moment it happens. Ad spend is a
process you start and then cannot stop from inside — the platform keeps charging while your poller
is down, your laptop is asleep, or your token has expired. Three enforcement layers, because each
fails differently and no two are redundant:

**A. Platform-side daily caps.** Written to every ad set as your number, on every write. The only
control that survives your process dying entirely — exactly the scenario the other two cannot
cover.

**B. A pacing poller.** Compares actual burn against `pacing_plan` every five minutes on the
injected `Clock`, calling `ads.pause_*` on breach. Catches overspend while you are alive but the
agent is wrong.

**C. The `ad_account.halted_at` row.** Checked by `om-outbox` before any write leaves the building,
flippable from `om ads halt` with no agent, no UI and no session running. The control a human
reaches for at 2 a.m.

> ### Where the desktop premise breaks
> Not in the UI — in the credentials. A laptop that sleeps cannot pace a budget, and a local
> sidecar holding live Meta credentials is a machine that wakes on Monday having spent the weekend
> unattended. **Local sidecar mode must refuse to bind a production ad account** — sandbox account
> or read-only, enforced in code. Electron is a console, never the custodian. Three architects
> reached this independently.

---

## Analytics: three number systems that will never agree

Not one truth, and not two. Name all three rather than blending them:

1. **Your ledger** — `message_delivery`, `spend_ledger`, `conversion`. Immutable facts you caused. Only this one reconciles.
2. **Platform-reported** — `platform_metric_snapshot`, keyed by `as_of` and `attribution_window`. Meta's 7-day-click and Google's data-driven model will both claim the same sale, and the email journey will claim it a third time. This can only be tracked for drift.
3. **Your own attribution** — `touch` → `conversion` under one declared model.

They will never sum to the same number, and the UI must stop pretending. The `reconciliation`
screen shows all three side by side *with a labelled gap*.

**Postgres holds; ClickHouse is not needed.** Ad data is ad-sets × days × metrics — thousands of
rows, not billions. Event volume is the only real risk, and the answer is rollup tables with
watermarks. Go columnar when a *named* query is measurably too slow, not before.

---

## Build order

1. **Spine, gates and `Clock`** — identity before the first contact exists; retrofitting merge onto an email-keyed schema eats a quarter
2. **Ledger, dispatcher, `render()`** — the per-recipient ledger ships with the first send, never later
3. **Journeys** — `journey_run` plus poller plus the node taxonomy
4. **Landing pages, forms, web-tracker — before any ad write** ← *the load-bearing ordering choice: buying traffic you cannot convert into a `subject_identifier` is buying nothing*
5. **Ads, read-only** — connect, mirror, ingest metrics, build reconciliation. Learn the platform before you let it charge you
6. **Ads, write** — behind `spendability()`, the outbox and the kill row
7. **Conversion feed** — with match-rate alerting shipping *at the same time*, not after
8. **Creative** — two `PollingVendorAdapter`s, asset library, provenance, variants
9. **The creative-fatigue loop** ← *fatigue detected → variants generated → six ratios cut → rotated into an already-approved creative set without a new gate. That closed loop running unattended is the product*
10. **MCP broker** — before any third-party server touches production
11. **Attribution**
12. **Desktop shell** — last, and deliberately so

**Scope v1 hard:** Meta only, image only, ledger-only analytics. The loop still closes. Building
four complete ad adapters at once would undermine the one thing that differentiates this product.

---

## What will actually go wrong

> ### Silent conversion-feed decay
> Match rates on hashed-email uploads sit around 40–70% and drift downward as normalization bugs
> creep in: a lowercase-and-trim missed on one code path, Gmail dots not stripped, a phone number
> sent without its E.164 country code. Meta accepts every payload with HTTP 200 and quietly matches
> fewer people. The algorithm gets a thinner signal, CPA rises gradually, and it reads exactly like
> normal auction pressure or seasonality.
>
> Meanwhile the `erasure` cascade misses the same rows for the same reason — so deletion requests
> silently fail against the one destination where failure is a regulatory event. **Both failures
> share a root cause and neither raises an error.**

**The mitigation ships with the feed, not after it:** persist the exact hashed value sent in
`conversion_transmission`; alert on match-rate deviation from a rolling baseline as a first-class
rule; and make erasure replay against stored transmissions rather than re-deriving hashes from
live subject data that may have changed since.

A second, slower failure predicted from a different angle: the gravitational pull of an existing
working chat pane. If the first commit is another chat PR rather than `subject_identifier` DDL and
a `Clock` port, in six months there is a polished console that can talk about campaigns, with no
ledger, no `sendability`, and no journey that survives a restart.

---

## Talking to the ad platforms: adapter or MCP?

**This fork was never put to the architects, so this section is a decision to make rather than a
finding.** All five independently assumed first-party adapters and listed the ad platforms as
EXTERNAL *services* — none proposed reaching Meta or Google over MCP, and none argued against it
either.

### What "launch a campaign" actually requires

The hierarchy is near-identical across platforms — Meta calls it Campaign → Ad Set → Ad, Google
calls it Campaign → Ad Group → Ad:

- **Campaign** holds the objective (awareness, traffic, leads, conversions, sales) and often the budget
- **Ad set / ad group** holds the audience, schedule, placements and bid strategy
- **Ad** holds the creative: image or video, headline, body, call-to-action, destination URL

Launching means: create the objective → define the audience (interests and demographics, a custom
audience uploaded from your list, or a lookalike built from your customers) → set budget and bid
strategy → attach creative → **submit for platform review**, which takes hours and can reject you
→ then poll status, watch CPM/CTR/CPA/ROAS, and reconcile what the platform says against what you
asked for.

That last clause is why the shape matters. A campaign launch is not one call. It is a multi-entity
write with partial-failure modes, an asynchronous review gate, and a permanent reconciliation
obligation — which is precisely what `campaign-plan` (desired state) plus `platform-sync`
(reconciler with a `platform_drift` log) exist to handle.

### Why first-party adapters, not MCP, for the platforms themselves

1. **MCP tool calls can bypass your risk tiers.** `agent-install` wires MCP servers into the coding
   agent's own config, so those calls never reach `ToolExecutor`. A creative MCP that bypasses your
   gates returns a bad image; an ad MCP that bypasses them spends your money with no `spendability()`
   check. **[source-verified]**
2. **Credentials cannot leave `apps/server`.** Handing long-lived Meta OAuth tokens to a third-party
   MCP process contradicts `om-secrets` and the "never handed to an MCP server" rule.
3. **`om-outbox` needs to own every platform write.** Idempotency keys and the `ad_account.halted_at`
   kill row only work if all writes pass through one place. An MCP server calling the API on your
   behalf is a write you cannot fence.
4. **Reconciliation is stateful and ongoing.** A generic MCP tool returns a result; `platform-sync`
   needs a durable desired-vs-observed diff, review-status polling and drift logging.

### Where MCP genuinely fits

- **Creative generation** (Higgsfield, Seedance) — swappable, non-credentialed against your money, and already supported by the `PollingVendorAdapter` tier.
- **Research and read-only enrichment** — competitor lookups, keyword tools, trend data. No spend, no PII export.
- **Bring-your-own tools** the operator adds themselves, brokered through `mcp-broker` with a per-server allowlist, output bounding and taint tagging.

The rule that falls out: **MCP for capabilities that cannot spend money or export identifiers;
first-party adapters for everything that can.** Tainted MCP output may reach the model, but must
never appear in the arguments to a durable-approval tool.

### The pragmatic middle path

Existing open-source Meta/Google Ads MCP servers are a legitimate accelerator for **read-only**
work — pulling metrics, listing campaigns, inspecting review status — during build steps 5 and 6,
before your own adapters are complete. Wire them through `mcp-broker` with write tools excluded by
allowlist. Then replace them with first-party adapters at the moment you need to write, because
that is when the outbox, the kill row and `spendability()` start carrying weight.

**If you want Open Marketing to be driven *by* other agents** — the mirror of this question — the
answer is the opposite direction and much cheaper: expose OM's own capabilities as an MCP server.
Jini already does exactly that (`src/server/tool-server.ts`, plus a `jini-mcp` binary), so an
external agent could drive your campaigns through the same `ToolExecutor` and the same five
approval gates, with none of the boundary problems above.

---

## How the disagreements resolved

Four questions split the architects. Three were settled by going to the source — in two cases
against the position the architect had argued first.

### Is `@jini-ai/capability-providers` usable? — both sides were partly right

`DbProvider` (`src/db.ts:29`) is a collection/record store, so **nothing from it goes under the
spine**. But the realtime `./adapters/ws` adapter and the `AuthProvider` *port* are genuinely
consumable. The catch: `JwtAuthProvider` keeps users in process memory, so the auth
*implementation* is new Postgres code.

Astra was right that it is usable, and wrong if that meant "as the data layer." Opus and Fable
were right about the ledger and overshot in rejecting the package wholesale.

### How big is creative generation? — thin, confirmed twice

Opus 5 and Fable 5.1 both verified in source: a binding layer of one host tick, a ~200-line
Postgres store adapter, two vendor polling adapters and one metadata row. Both **corrected their
own earlier drafts** after reading `dispatch/`. Gemini 3.1 Pro specified a whole new
`generation_job` table plus a `setInterval` poller — reasoned from the brief rather than the code,
and would rebuild machinery that already exists.

### Commerce and experimentation — defer the module, reserve the field

Commerce context defers as a module, but reserve `conversion_event.value`, `currency` and an
`order_id` identifier kind **from day one** — same logic as identity: cheap now, a migration later.
Experimentation defers too, except a global `holdout` group that ships in Phase 0, because it is
the only honest way to reconcile platform-claimed conversions against your own ledger. Without it,
the three number systems have no referee and you are left arguing with Meta's attribution window
forever.

### Do you build landing pages? — still open

Opus 5 and Astra say yes, on `@jini-ai/cms`. Fable 5.1 says no page builder — store only
`landing_page{url, utm_template, form_id}` and point at Tovu or any external site. This is the one
question source-reading cannot settle, because it is a product decision rather than a factual one.
All three agree `@jini-ai/cms` has no forms module, so **forms are yours either way** — the split
is only over whether you also own the page.

---

*Synthesized from five independent architecture reviews run against the same brief, grounded in the
Jini engine source and a prior survey of twelve open-source marketing tools. Disagreements are
listed rather than averaged.*
