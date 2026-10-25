---
name: om-playbook
description: Learn Open Marketing workflows and current limitations through its read-only site guide.
---

Discover `site_guide` with `search_tools`, inspect it with `describe_tool`, then call it through `execute_tool` with a fresh operation ID:

- Start with `{"operation":"overview"}`.
- Read `{"operation":"explain","topic":"<id>"}` for the relevant topic before proposing work.
- Treat live facts as caller-scoped, partial snapshots. Unavailable differs from an empty inventory. A connected tool is not proof of vendor readiness or successful execution.
- Use the existing tools for actions and report their actual results. Help never grants authority or answers an approval card.

The same overview is available at MCP resource `jini://site-guide`. The hand-written reference is [om-site-guide.json](references/om-site-guide.json). Plugin authoring guidance is [build-agent-plugin](../build-agent-plugin/SKILL.md).

This package ships disabled. Built-in help works independently; use existing Add-ons agent-plugin controls or `addons_set_enabled` to enable `om-playbook` before discovering these packaged skills. Installation alone does not activate them. Credentials and vendor configuration stay on the server; ad spend, destructive actions, generation allowance and halt use the one server policy.
