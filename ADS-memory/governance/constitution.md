# OM constitution — accepted decisions, adoption status per v2


**Status:** Owner decisions and B1–B8 are ratified inputs. This consolidated constitution remains a draft artifact for formal adoption; it does not reopen those decisions.

### Article I — Replaceability and feature ownership

OM uses independently testable feature workspace packages in top-level `features/`. External consumers import only stable package names through the package’s public entry. Each feature owns its data. Boundaries are executable checks; relocation does not rewrite consumers.

### Article II — Explicit dependencies and composition

Owned functions use at most two required/optional object arguments. All I/O and app-specific configuration are injected. **B6:** One composition root per app; modules do not construct their own dependencies. **B7:** Time is an injected clock. No hidden singleton or mutable global registry.

### Article III — Library-first simplicity

Use maintained libraries where they solve the problem. Domain logic remains deliberate. An abstraction requires a present need and a real second consumer or concrete replacement/test implementation. No speculative platform or framework.

### Article IV — Test-first contracts and boundary trust

**B1:** Every port has one shared contract suite run against its in-memory double and real adapter. Meaningful behavior precedes implementation; bug fixes demonstrate red/green regression evidence.

**B3:** Parse and schema-validate HTTP, MCP results, manifests, CLI input, and environment at boundaries. Third-party output is tainted until validated.

### Article V — Bounded complexity and declarative UI

Cognitive complexity is at most 10 and maximum nesting depth at most 3, enforced as errors across all first-party extensions. Cyclomatic complexity and function size are reported, never gated. Exhaustive switches over discriminated unions remain required and are proven compatible by the 14-arm fixture.

React follows its canonical [AI Dev Shop rule](/Users/la/Programming/Open-Marketing/AI-Dev-Shop/framework/operations/react-skill-operations.md): no functions in `.tsx` component bodies, including inline JSX arrows. Markup/composition stays in components; logic and callbacks live in adjacent hooks/rules modules.

### Article VI — Design for user ease first, with explicit money authority

Design for user ease first. The authenticated owner can complete ordinary work without unnecessary setup or repeated ceremony.

Every ad-spend call receives exact-argument confirmation; MVP has no budget envelope or reallocation authority.

Generation within the configurable daily allowance, default $10/day, uses normal write confirmation and may use Always allow. Over-allowance or unknown-cost generation requires explicit spend approval without Always allow. Current limits, reservations, and authority remain mandatory.

**B4:** Irreversible actions fail closed; module-boundary errors are explicit typed values.

### Article VII — Protected server and separate agent

Server owns credentials, database, safety, federation, and durable workers. Agent is a separate process and accesses product capabilities only through authenticated OM MCP/HTTP. It receives no vendor credentials or vendor MCP configuration.

Production ad writes and conversions require an always-on server. Desktop-only/local ad-account mode is sandbox or read-only.

After local halt, only narrowly typed backend pause/stop calls may mutate the halted ad account. Typed conversion delivery uses a narrow measurement grant, dispatch-time consent, and egress audit.

### Article VIII — Self-contained plugins

Vendor skills, SDKs, codecs, OAuth details, MCP configuration, tool bindings, and backend implementation reside in the vendor Agent Plugin. Namespace is `io.github.ainsep.openmarketing`.

Plugins cannot weaken host confirmation or financial policy. Updates invalidate stale admission and grants.

### Article IX — Durable effects, truth, audit, and recovery

**B2:** External writes use stable idempotency keys and one transactional outbox. Unknown effects remain unknown until reconciled.

**B5:** Ledgers and audit are append-only; corrections append lineage.

**B8:** Run/correlation/trace IDs connect agent execution, logs, jobs, and outbound calls.

OM distinguishes ledger facts, platform reports, and its attribution model. Backup, restore, safe stop, and recovery are delivery responsibilities.

### Article X — Spec integrity and controlled change

Approved decisions/contracts govern implementation. Jobs report files, tests, contracts, migrations, risks, dependencies, and handoff.

Jobs cannot overwrite another active owner’s files or apply live migrations outside an assigned operation. Cross-cutting exceptions require recorded approval; finalized owner decisions are not reopened by implementation preference.

### Article XI — Surface parity

Every user-facing capability closes HTTP, studio, and `om` CLI in the same delivery. Machine-readable output cannot create a privileged bypass.

Internal service processing remains narrowly typed; its configuration and status are accessible through the operator surfaces.

