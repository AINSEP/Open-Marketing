# Debate brief — architecting "Open Marketing"

You are one of three independent architects (the others are a different model each).
You are NOT collaborating. Take a clear position and defend it. You will be scored on
specificity and on being right, not on being agreeable or comprehensive.

## The proposition to attack or defend

Build **Open Marketing**: an open-source marketing automation product, delivered as a
**desktop app**, built on the **Jini** engine (an existing, real, product-neutral agent
runtime). The pitch in the owner's words: "I can basically just spin up a chat, and then
we have tool calls, and we can automate pretty much all marketing."

Structured similarly to **Tovu**, an existing product built on the same engine.

## What already exists (verified facts, not hypotheticals)

**Jini** — `/Users/la/Programming/Jini`. A reusable, product-neutral engine for running
coding agents, exposing tools/providers, and streaming durable run events over HTTP, CLI,
MCP, and sidecar transports. Extracted from Open Design; publishable `packages/@jini-ai/**`
must stay free of product-specific behavior. Real packages today:

- `protocol` — the wire contract: run, event, journal, registry, error types. Types + zod only.
- `daemon` — the stateful agent daemon: run lifecycle, durable event log, tool-execution
  boundary, agent executor driving real coding-agent subprocesses, terminal sessions, a
  routine scheduler. Largest, most stateful package.
- `agent-runtime` — runtime adapter registry/detection for agent CLIs, plus portable skills.
- `agentic` — framework-free agent control: capability vocabulary (what a page may be asked
  to do), a `data-agent-*` markup convention components use to publish themselves,
  projections onto WebMCP and AG-UI, a six-event model. No React, no DOM, no transport.
- `chat` — chat core + React surface.
- `capability-providers` — five swappable ports (auth, blob storage, payments, document
  store, realtime pub/sub) as narrow interfaces + DI tokens. Interfaces only at root.
- `desktop-host` — the shell-agnostic half of a desktop app: six ports (single-instance
  lock, main-window lifecycle, custom URL scheme, sidecar launch/supervision, headless
  render service, external URL/folder opening). Electron or Tauri wrapper plugs in.
- also: `mcp`, `memory`, `sandbox`, `registry`, `sqlite`, `http-kit`, `tokens`, `artifacts`,
  `cms`, `ui`, `integrations`, `core`, `server`, `sidecar`, `cli`, `admin`, `plugins` (an
  empty reserved placeholder today).

**Tovu** — the structural precedent, and it is a TWO-repo split:
- `Tovu` = the product (a WordPress-like CMS runtime): `apps/website`, `apps/admin`,
  `apps/site-chat`, `packages/sdk`. 2,388+ commits.
- `Tovu-Runner` = the desktop host, a SEPARATE repo: flat Electron app (`src/`,
  `electron-builder.yml`), owns multi-site management, media/video generation, agent
  detection, and the operator chat.
- **ADR-011: the dependency arrow only ever points Runner → Tovu, never reverse.**
- `Tovu/apps/desktop` is a thin Electron shell around the same product the web mode serves,
  depending on `@jini-ai/chat`. Its own description: "Additive: nothing outside this
  directory knows it exists."

## The domain research (already done — do not redo it)

A survey of 12 open-source marketing tools (chatwoot, dittofeed, formbricks, inngest, jitsu,
listmonk, matomo, mautic, novu, rudder-server, trigger.dev, unomi) produced a capability
synthesis at `/Users/la/Programming/OSS-Marketing-Repos/docs/capability-synthesis.md`.
You may read it and the sibling per-repo docs. Its load-bearing conclusions:

**No durable-execution dependency is needed.** Not Temporal, not process checkpointing, not
a workflow VM. For a finite graph of known steps (enter, delay, branch, send, exit), the
honest design is a `journey_run` table with `resume_at` / `wait_event` columns plus a poller,
in Postgres. Take dittofeed's node taxonomy, not its substrate.

**Licensing is the binding constraint, not code quality.** Seven distinct patterns across
eleven repos: a live network licence check (formbricks phones ee.formbricks.com), an
enterprise package simply absent from the tree (dittofeed), an unchecked-out git submodule
(novu), SSPL-with-auto-Apache-after-three-years (inngest). listmonk is AGPLv3 whole-tree and
rudder-server is Elastic License 2.0 — both ideas-only, no code.

**Recommended build order:** 0. data spine (`subject`, `subject_identifier`, `subject_merge`,
`attribute_definition`, `event`, `message_delivery`, `suppression`) — identifiers before the
first contact exists, because retrofitting merge onto an email-keyed schema "eats a quarter."
1. Sending with a per-recipient ledger + send-time suppression check. 2. Templating with
compliance in the base layout + signed preference page (ships WITH 1, not after). 3.
Segmentation: typed node tree, one condition→SQL compiler, evaluated live, no cache.
4. The journey engine. 5. Incremental recompute. 6. Deliverability. 7. Outbound webhooks.
8. Event ingestion. 9. Multi-tier preferences.

**Explicitly deferred:** ClickHouse, Kafka, CDP profile building, device fingerprinting,
multi-tenant fairness machinery, user-authored transformation sandboxes, in-app inbox,
warm-up scheduling, and "an admin UI ported from anywhere — every doc says skip the
dashboard, all five are wrong-framework or wrong-generation."

**Eight things nobody solved well** (where we invent, not adapt): journey versioning while
users are mid-flight; reconciling consent + suppression + audience membership (design one
`sendability` function both the audience builder and sender call, returning a reason);
warm-up and per-domain reputation (zero implementations across twelve repos); preview/test-send
fidelity (build preview as the SAME function with a mocked recipient, never a parallel path);
cross-channel frequency capping; analytics that agree with the delivery ledger; the tenancy
decision (decide before build step 4); and testing an engine whose unit of work is three days
long (**expose an injectable clock from the first commit** of the journey engine).

## What you must answer

1. **What are the components?** Name them. Say which are new Open Marketing code, which are
   existing `@jini-ai/*` packages consumed as-is, and which need a new engine package. Be
   concrete about the repo/workspace layout — one repo or the Tovu two-repo split, and why.

2. **What should it look like?** The actual product surface. The owner's mental model is
   "spin up a chat and tool-call your way through marketing." Is a chat the right primary
   surface for this domain, or is it a trap? A marketing operator needs to see a segment of
   120,000 people, a journey graph, a template, and a delivery ledger. Say what the main
   window actually contains.

3. **The hard call.** Where does the agent boundary sit? Which marketing actions may an LLM
   take autonomously, and which require a human gate? An agent that can send email to 120,000
   people is a different risk object than one that edits a file. Be specific about the gate.

4. **What is the single biggest thing that will go wrong with this plan?** One paragraph.
   Not a hedge — your actual prediction.

## Rules

- Be concrete and opinionated. Name files, tables, packages, and screens.
- Disagreeing with the premise is allowed and encouraged if you can argue it. In particular:
  the desktop-app choice and the chat-first surface are both open to attack.
- Do NOT write any code or modify any files. Prose and structure only.
- Budget roughly 900-1400 words. Dense over long. No preamble, no summary of this brief.
