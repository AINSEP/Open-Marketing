---
name: om-playbook
description: Learn Open Marketing workflows and current limitations through its read-only site guide.
---

Discover `site_guide` with `search_tools`, inspect it with `describe_tool`, then call it through `execute_tool` with a fresh operation ID:

- Start with `{"operation":"overview"}`.
- Read `{"operation":"explain","topic":"<id>"}` for the relevant topic before proposing work.
- Treat live facts as caller-scoped, partial snapshots. Unavailable differs from an empty inventory. A connected tool is not proof of vendor readiness or successful execution.
- Use the existing tools for actions and report their actual results. Help never grants authority or answers an approval card.

The same overview is available at MCP resource `jini://site-guide`. The hand-written reference is [om-site-guide.json](references/om-site-guide.json).

## Skills

- [ad-copy-variants](../ad-copy-variants/SKILL.md) — Use when drafting evidence-grounded paid ad copy variants using audience awareness, PAS or AIDA, and the 4 U's for platform headlines, descriptions and feed text; drafting grants no publishing or spending authority.
- [analytics-attribution-basics](../analytics-attribution-basics/SKILL.md) — Use when explaining OM attribution, unattributed leads, conflicting conversion totals, cost per verified lead, and customer acquisition cost without inventing metrics.
- [build-agent-plugin](../build-agent-plugin/SKILL.md) — Use when building a self-contained Open Marketing agent plugin using existing upload, activation and server policy.
- [creative-fatigue-review](../creative-fatigue-review/SKILL.md) — Use when reviewing possible creative fatigue using comparable performance and exposure evidence, checking competing explanations, and recommending a controlled refresh.
- [creative-test-plan](../creative-test-plan/SKILL.md) — Use when planning a single-variable creative experiment with a control, hypothesis, primary metric, product-computed sizing, and predefined winner, kill, and inconclusive rules.
- [landing-page-cro](../landing-page-cro/SKILL.md) — Use when reviewing a landing page for conversion friction, message match, clarity, proof, forms, mobile usability, accessibility, and measurement.
- [strategy-and-brief](../strategy-and-brief/SKILL.md) — Use when drafting a concise marketing strategy or campaign brief from the objective, audience, offer, evidence, constraints, and success measure.

This package ships disabled. Built-in help works independently; use existing Add-ons agent-plugin controls or `addons_set_enabled` to enable `om-playbook` before discovering these packaged skills. Installation alone does not activate them. Credentials and vendor configuration stay on the server; ad spend, destructive actions, generation allowance and halt use the one server policy.
