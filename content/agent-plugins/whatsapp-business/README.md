# WhatsApp Business (R1: reads/auth)

Inert, server-loaded Agent Plugins 1.0.0 package. `get_account_status`,
`list_senders`, and `list_templates` expose verification, review, name approval,
quality and messaging tier observations. Missing values remain unknown.

Import only `@open-marketing-plugin/whatsapp-business`. Construct
`createWhatsAppBusinessAdapter({ configuration, credentials, gateway, fetch,
clock, observer, createDeadline })`; invoke with `{ context, operationId,
command: { kind: "get_account_status" } }`. Results use canonical `Outcome`.
Lists accept `limit` (1–100, default 100) and opaque `after`; return `{ items,
cursor }`. Each call fetches one page; provider next URLs are discarded.

The host injects `createDeadline({ timeoutMs })`, returning a fresh abort signal
for each GET (15,000ms). It covers fetch and streamed body reading. Caller aborts
return `cancelled`; deadline failures return `unavailable`; neither retries.
Requests are capped at 64KiB and streamed responses at 1MiB; redirects are blocked.

Both manifest and capability admission start false. Admit only after verifying
Graph v26.0 field compatibility, permissions and asset binding; these remain
unverified. The gateway rechecks authority BEFORE broker access/refresh/fetch;
the broker verifies scope, connection, WABA/phone ownership, token expiry and
`whatsapp_business_management`. Host audit is authoritative; observer events
carry run/correlation/trace IDs without bodies or secrets.

`credentialCards` uses the host schema: Meta connection reuse (OAuth action
unavailable until integrated), or sealed system-user token with WABA/phone IDs.
No second OAuth route or token storage is implemented. NEEDS: server composition,
broker/gateway adapters, compatibility verification, real-host shared-suite run,
HTTP/OM MCP/CLI parity, packaging and DS2 presentation. No shared contracts or
migrations changed. Sends, pricing, consent and delivery/webhook integration
remain deferred; their safety rules are in [SKILL.md](skills/whatsapp-business/SKILL.md).

`mcpServers` is empty: Meta MCP remains unverified; Twilio account/documentation
servers do not supply direct Meta reads. See [primary-sources.json](io.github.ainsep.openmarketing/evidence/primary-sources.json)
for research and limits. Fixture tests are written, not run; one lane typecheck
is permitted. No builds, installs, live vendor calls or migrations.
