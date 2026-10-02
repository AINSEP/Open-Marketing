# Fable 5.1 — architect answer
(Section 1 partially truncated in delivery; remainder resent and stitched here.)

## 1. Components and layout
Start from Jini, not from this repo. The workspace named Open-Marketing is the Open
Design fork: apps/daemon/src/server.ts is 9,452 lines, cli.ts is 9,696, and there is not
one @jini-ai/* dependency anywhere in package.json, apps/*, or packages/*. Jini was
extracted FROM this code; continuing here means privately maintaining the engine Jini
already supersedes. Tovu did the right thing (ADR-049: adopt the published kernel, drop
the hand-rolled CopilotKit/AG-UI plan). Do the same: a fresh pnpm workspace consuming
@jini-ai/* from npm, keeping apps/web/src/components/om-chat/ as the only carry-over.

One repo, not the Tovu two-repo split. The split exists because Tovu has a WordPress-mode
single binary that must never depend on a desktop host, and Tovu-Runner is a multi-site
manager over many install dirs. Open Marketing has neither. Keep ADR-011's one real rule
(dependency arrow desktop -> product, never reverse) as a workspace boundary.

New Open Marketing code:
- packages/om-schema — Postgres DDL/migrations: subject, subject_identifier, subject_merge,
  attribute_definition, event, message_delivery, suppression, consent, segment, journey,
  journey_run, journey_run_step, template, sending_domain, approval. Postgres not SQLite.
- packages/om-engine — pure domain, no HTTP: segment/ (Zod node union, one evaluate(),
  one compile() -> {sql, params}), journey/ (poller, interpreter, eight Dittofeed node
  handlers, Clock port injected from commit one), send/ (sendability(), ledger writer,
  hash(run_id,node_id,attempt) idempotency), render/ (Liquid, compliance base layout,
  preview = render(template, mockRecipient) as the same function), deliverability/.
- packages/om-contracts — DTOs and zod for /api/om/*; shared shape for web, CLI, agent tools.
- packages/om-tools — agent tool registrations (@jini-ai/core Pack ToolRegistrations).
  Every tool names an object id, declares risk, carries the gate policy.
- apps/server — one Express process: @jini-ai/http-kit route registrars alongside OM routes,
  owns RunLifecycle + ToolExecutor + ToolRegistry together, runs journey poller and send
  worker. Docker-deployable with a Postgres URL.
- apps/web — Vite/React operator console on @jini-ai/chat/react and @jini-ai/ui.
- apps/desktop — thin Electron via @jini-ai/desktop-host/electron; sidecarLauncher supervises
  apps/server in local mode; @jini-ai/agent-runtime detects the operator's claude/codex CLIs.
- apps/cli — om on @jini-ai/cli: --json, --prompt-file, om approve <id>.

Consumed as-is: protocol, core, daemon, agent-runtime, http-kit, sqlite (run event log only,
never marketing data), chat, agentic, desktop-host, mcp, cli, tokens.

Explicitly NOT consumed: capability-providers' DbProvider is a collection/record store
(insert/get/update/delete/query); a delivery ledger needs joins and row locks, and forcing it
through that port would be a lie. daemon's routine scheduler calls Date.now() directly
(routines/scheduler.ts:153); journeys do not go on it. cms, artifacts, admin are irrelevant.

One new engine package required: a durable approval store. ToolExecutor.resumeConfirmation
exists but is in-process and dies with the run; a broadcast approval may sit for a day and be
answered from the CLI. The 07-09 handoff already found the gap: GenUI's respond route wakes no
waiter and markTimeout has zero callers. Build @jini-ai/approvals (pending-decision rows,
waiter registry, sweeper, CLI/HTTP/MCP answer paths) once, product-neutral. A Postgres EventLog
adapter is nice-to-have, not blocking.

Desktop, honestly: wrong home for the engine, right home for the operator. A journey_run with
resume_at in 72 hours cannot depend on a laptop lid; the engine is a server that CAN run as a
sidecar. The real reason desktop is right: the agent runs on the operator's machine with their
own CLI subscription and keys, which is exactly what agent-runtime is for.

On Codex's two-repo argument: I agree with every word of the premise and it is already my
design. apps/server is the always-on, Docker-deployable process that owns the poller, delivery
callbacks, webhook ingestion, and suppression; apps/desktop is a console that sidecar-launches
it only in local mode. That premise argues for a server/console PROCESS boundary, which a
workspace boundary enforces just as hard as a second repo; a second repo adds version pinning
and contract-fixture drift (ADR-011's own "Consequences" section lists that cost) and buys
nothing Open Marketing needs. One repo, hard boundary, stands.

## 2. Product surface
Chat-first is a trap as the primary surface and correct as the secondary one. The domain's
objects are large sets, a graph, a rendered document, and an audit ledger; a chat can reference
them but cannot be them. "Why didn't Alice get the email" is a journey_run_step.reason lookup,
not a conversation. The agent's real value is authoring, which produces documents that must be
reviewed before a gate; a review needs a canvas.

Three panes. Left nav: Audience, Journeys, Messages, Deliveries, Deliverability, Settings.
Center: the object canvas. Right: agent pane (@jini-ai/chat/react), collapsible, bound to
whatever is in the center through @jini-ai/agentic's data-agent-* handles.

Screens: Audience = typed-tree segment builder with live count from compile(), plus subject
detail (identifiers, merge history, consent, timeline). Journeys = graph editor with live count
per node from journey_run.current_node_id, version banner ("3,204 people mid-flight on v3"),
pause/resume. Messages = template edit, preview via the same render() with a mock recipient,
test-send. Deliveries = the ledger, faceted by reason. Deliverability = per-domain acceptance,
warm-up ramp, suppression.

Every agent proposal lands in the center as the real object in draft status, never as prose:
"Proposed segment, 118,402 match" opens the builder with the tree filled in. Chat is a command
palette with memory, not the app.

## 3. The agent boundary
Enforce in ToolExecutor (ToolPolicy.authorize plus ExecutionDelegate.onConfirm), never in the
prompt. There is no send_email(to, body) tool; the tool surface exposes intents on named
objects, and only om-engine/send holds provider credentials.

Autonomous: all reads; creating/editing anything in draft; preview; test-send to an
operator-maintained allowlist; and every action that REDUCES sending: pause a journey, cancel a
broadcast, add a suppression, add a subject to a do-not-contact group.

Confirm-in-run (Jini's existing resumable confirmation): edits to a live template, segment
definition edits on a segment referenced by a running journey, subject merge.

Durable approval (@jini-ai/approvals): anything that INCREASES sending or touches consent.
Publish a journey version, launch a broadcast, resume a paused journey, remove a suppression,
change sending_domain. The gate is a row: approval{action, definition_hash, audience_count,
sample_recipients[20], preview_hash, expires_at, approved_by}. Approval happens in the UI or
om approve, never via a tool call the agent can make. At execution the engine recomputes
sendability and refuses if the count drifts more than 5% or either hash changed. Default
max_recipients_without_approval = 0. Decide tenancy now: single workspace, workspace_id on
every table, one poller, no fairness machinery.

## 4. What goes wrong
The starting point. The last two sessions of this repo went into chat substrate (GenUI waiters,
the inactivity watchdog, the AG-UI relay), and zero lines went into subject_identifier. The
gravitational pull of 19,000 lines of working daemon plus a chat pane that already renders tool
calls will keep the team "building marketing on the fork because the chat already works." The
data spine gets laid late, on top of an email-keyed contacts table, and the OD->OM rebrand
masquerades as progress. In six months there is a polished agent console that can talk about
campaigns and no delivery ledger, no sendability, and no journey that survives a restart. The
tell is the first commit: if it is subject_identifier DDL and a Clock port, this plan works;
if it is another chat PR, it does not.
