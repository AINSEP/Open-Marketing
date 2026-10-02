# Design brief v2 — Open Marketing, full scope

This is a SOFTWARE ARCHITECTURE question about a real project. It is not a competitive
debate: do not use affirmative/negative framing, do not adjudicate, do not award a ballot.
You are one of several independent architects (each a different model). Take positions.

## The product

**Open Marketing**: open-source, full-fledged marketing campaign software, delivered as a
**desktop app** with an always-on server component, built on the **Jini** agent runtime.
The owner's scope, verbatim: "control ad campaigns, bring in images and assets, connect
external MCPs like Higgsfield and Seedance, run campaigns and analytics and all of that
for marketing — a full fledged marketing campaign software... What are all the modules we
need? We have the chat stuff from Jini, but what else do we need? We need a comprehensive
plan to create this."

So the product spans FOUR domains, not one:
- **Lifecycle/messaging** — email/SMS sending, journeys, segments, deliverability.
- **Paid media** — ad campaigns across Meta/Google/TikTok/LinkedIn: budgets, bids,
  audiences, creative rotation, spend pacing.
- **Creative production** — generating and managing images and video via external AI
  services, plus an asset library.
- **Analytics** — campaign performance, attribution, spend efficiency, reporting.

All four are driven by an agent with tool calls, through a chat surface from Jini.

## SETTLED — build on these, do not re-litigate

A prior round already resolved these for the messaging half. Two independent architects
agreed, and their reasoning was verified against the real codebases. Treat as given:

- **Data spine first.** Postgres: `subject`, `subject_identifier`, `subject_merge`,
  `attribute_definition`, `event`, `message_delivery`, `suppression`, `consent`. Identity
  is never keyed on email. Retrofitting merge later "eats a quarter."
- **One `sendability(subject, channel, purpose, ...) -> {allowed, reason}`**, called by both
  the audience estimator and the dispatcher. A mismatch is a correctness bug.
- **Journeys** = `journey_run` table + `resume_at`/`wait_event` + a Postgres poller with
  `FOR UPDATE SKIP LOCKED`. **No Temporal, no workflow VM, no process checkpointing.**
  Immutable pinned `journey_version`; never migrate in-flight runs.
- **Injectable `Clock` port from the first commit**, or every journey test becomes a sleep.
- **Preview is the same `render()` function** with a mocked recipient, never a parallel path.
- **Chat is the secondary surface, not the primary one.** Three panes: left nav, center
  object canvas, right collapsible agent pane. Agent output lands as a real object in
  `draft` status that opens in the canvas — never as prose in a transcript.
- **One repo, hard workspace boundary.** `apps/server` is always-on and Docker-deployable
  (owns pollers, callbacks, ingestion); `apps/desktop` is an Electron console that
  sidecar-launches it in local mode. Dependency arrow desktop -> product, never reverse.
- **Build on published `@jini-ai/*`**, not on the existing Open Design fork (verified: that
  repo has zero `@jini-ai` dependencies and is the code Jini was extracted from).
- **A new product-neutral `@jini-ai/approvals`**: durable pending-decision rows answerable
  from UI/CLI later, because in-process confirmation dies with the run.
- **Gate fatigue is a real failure mode.** An approval gate that fires hundreds of times a
  day trains operators to rubber-stamp it, turning the safety mechanism into theater.
  Gates must be rare to stay meaningful.

## Jini — what already exists to consume

Product-neutral engine, published as `@jini-ai/*`. Real packages: `protocol` (wire
contract), `daemon` (run lifecycle, durable event log, tool-execution boundary, agent
executor driving real agent CLIs, routine scheduler), `agent-runtime` (adapter
registry/detection for agent CLIs), `agentic` (capability vocabulary, `data-agent-*` markup
convention, WebMCP/AG-UI projections), `chat` (core + React), `mcp`, `memory`, `sandbox`,
`registry`, `sqlite`, `http-kit`, `tokens`, `artifacts`, `cms`, `ui`, `core`, `cli`,
`desktop-host` (six ports: single-instance lock, window lifecycle, custom URL scheme,
sidecar supervision, headless render service, external open), `capability-providers`
(auth/blob/payments/docstore/realtime ports — note its `DbProvider` is a record store and
cannot express a delivery ledger's joins and row locks).

## The NEW territory — this is what you are actually being asked

**1. Paid media.** Ad platforms are not email. Spend is irreversible and continuous; a bad
bid burns money while nobody is watching. Budgets, bid strategies, ad-set structure,
creative rotation, pacing, platform-side audiences (custom/lookalike, hashed-email upload —
which collides with consent), and each platform's own review/approval latency. Ad accounts
get suspended. How is any of this modeled, and how does the money boundary differ from the
sending boundary?

**1b. The conversion-tracking loop — treat as first-class, not plumbing.** Modern paid ads
work because conversions are reported BACK to the ad platform, whose algorithm then optimizes
toward people likely to convert. Browser-side pixels were broken by ATT and cookie
deprecation, so this moved server-side: Meta Conversions API, Google enhanced conversions.
This is where identity, consent and ad platforms collide hardest — you are transmitting
hashed customer data to a third party. Where does this module live, what does it send, and
how does it reconcile with `consent` and `suppression`?

**1c. Landing pages and forms.** The destination an ad points at, and the mechanism that
turns anonymous paid traffic into a known `subject` with an email address. This is the
literal join between paid acquisition and lifecycle messaging, and therefore the moment
`subject_identifier` earns its existence. Formbricks was in the source survey. Is this a
module we build, an integration, or out of scope?

**1d. Creative fatigue is the reason creative generation matters.** Ad creative decays within
weeks; the same image stops performing and must be replaced, in ~6 aspect ratios per
platform. The supply of fresh variants is the treadmill paid media actually runs on. This is
the strategic case for Higgsfield/Seedance-class generation being core rather than a
side feature, and it is plausibly the product's main differentiator against Mautic or
listmonk, which have nothing like it. Say whether you agree and design accordingly.

**2. Creative production and assets.** Generating images and video through external AI
services (Higgsfield, Seedance and similar) reached over **MCP**. Generation is slow,
async, expensive, and non-deterministic. Assets need a library, versioning, provenance
(which prompt/model/seed made this), rights and licensing, brand consistency, and per-
platform variants (an ad creative is 6 aspect ratios). Is this a DAM, a cache, or an
artifact store — and does `@jini-ai/artifacts` cover it or not?

**3. External MCP servers as a trust boundary.** Third-party MCP servers are code the
operator did not write, given credentials and invoked by a model. Prompt-injection through
tool results is live. How do they plug in, how are credentials scoped, what does the
registry look like, and what stops a hostile or compromised MCP server from reaching the
send path or the ad-spend path?

**4. Analytics and attribution.** Note that every ad platform self-reports conversions using
its own attribution window and will claim credit for the same sale that email also claims;
platform numbers will never reconcile with your own ledger, and pretending otherwise is a
classic failure. The prior research flagged that nobody joins "what we sent" to "what
happened next" in a way that survives erasure, and that aggregated metrics routinely
disagree with the delivery ledger. Now add ad spend, impressions and platform-reported
conversions, which arrive late, restated, and sampled. Is there one truth or two? Where
does attribution live? Does this need a columnar store, or does the prior "Postgres until
measurably too slow" rule hold?

## What you must answer

1. **The complete module list.** Every module in the product. For each: one line on what it
   owns, and mark it `NEW` (Open Marketing code), `JINI` (consumed as-is, name the package),
   or `EXTERNAL` (third-party service/MCP). Include the four domains above and anything the
   brief has not thought of. This is the core deliverable — be exhaustive and concrete.

2. **The tool surface.** What tool calls does the agent actually get? Group them by module.
   For each group give a risk tier: autonomous / confirm-in-run / durable-approval. The
   design constraint is that gates must be rare enough to stay meaningful, so say what is
   batched into a single approval rather than gated per action.

3. **Money and the irreversible boundary.** Ad spend is continuous and cannot be recalled.
   Specify the actual control: caps, pacing, kill-switch, who holds the credential, what the
   agent may change autonomously inside an approved budget, and what the approval object
   contains for a campaign that runs for three weeks.

4. **Creative and MCP integration.** How generation jobs are modeled (they are slow and
   async — is this the journey poller, a separate job table, or Jini runs?), how assets are
   stored and addressed, and the concrete trust boundary for third-party MCP servers.

5. **Analytics truth model.** One store or two. What reconciles with the delivery ledger and
   what cannot. Say plainly whether ClickHouse is needed here or whether Postgres holds.

6. **Build order for the whole product**, phased, with a first-commit tell — a specific
   artifact whose presence proves the plan is being followed rather than drifting.

7. **The biggest thing that will go wrong** at this expanded scope. One paragraph, a real
   prediction, not a hedge.

## Rules

- Concrete over comprehensive. Name packages, tables, screens, tools.
- One structural argument to weigh explicitly: paid acquisition and lifecycle messaging are
  arguably a single loop, not two products — you buy an ad to obtain an email address, then
  lifecycle marketing monetizes it for years, and the join is `subject_identifier`. Say
  whether that makes this one product or three.
- The owner is new to marketing operations. Where a module exists for a domain reason rather
  than a technical one, say in one line what marketing job it does. Do not pad; one line.
- Attack the premise where you think it is wrong — especially the desktop choice, the
  four-domains-in-one-product scope, and whether this is one product or three.
- Every paragraph must carry specific technical nouns. Delete any sentence that could apply
  to any software project.
- Do NOT write or modify files, and do not run code indexers.
- 1400-2000 words.
