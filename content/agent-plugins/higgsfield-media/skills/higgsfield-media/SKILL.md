---
name: higgsfield-media
description: Guide an Open Marketing owner through browser OAuth connection, an asynchronous Higgsfield image job and server media import. Covers plan gates, bounded polling, reviewed pricing and the server-owned daily generation allowance.
---

# Higgsfield images in Open Marketing

Adapted from Tovu's Apache-2.0 guidance; see NOTICE and PROVENANCE. This package
ships disabled and unadmitted. Historical examples do not establish current
account entitlement, pricing or provider tool schemas.

## Connect

The owner enables the plugin and connects through the server connection flow,
then signs in to Higgsfield in their browser. Higgsfield uses OAuth, not an API
key. The server discovers metadata and, when authorized, registers a client.
Never request an API key or paste browser tokens into chat. Expired/revoked
authorization needs the host's reconnect action.

MCP configuration, OAuth state and sealed credentials stay on the server. The
agent receives only OM schemas and safe receipts. Discovery defaults are hints,
not permission to execute tools. Use current admitted capabilities.

## Request an image

Select a model using current server discovery and account evidence. A catalog
entry or successful quote does not establish plan entitlement. This binding
supports one image per operation, a supported aspect ratio and optional seed.
Video, batches and other flags need separately admitted bindings.

The server obtains a quote from reviewed evidence and asks safety for the card.
Known generation within the daily allowance uses normal write grants, including
Always allow. The default is USD $10/day, resetting at midnight in the owner's
local timezone. A timezone edit takes effect at the next rollover. Above-allowance
or unknown-cost generation needs explicit spend approval without Always allow
or a chat-wide waiver. Without a defensible upper bound, safety may refuse dispatch
even after an owner responds. This plugin cannot choose or weaken that policy.

Credits, trial/unlim flags and expired estimates are not zero dollars. Every
dispatch rechecks current authority, schema pins and credential use on the server.

## Follow the asynchronous job

Submission returns a pending provider job, not a completed image. A durable
server worker polls independently of the agent. Honor the returned delay; the
binding clamps it to 1–60 seconds and uses bounded attempts and an absolute
deadline. Do not use `sync: true`, busy-poll or resubmit after a timeout.

On completion, the server validates the structured image reference and retrieves
bytes through its guarded media boundary. Creative/media records the real asset,
original intent, provider job and cost provenance. Report a usable image only
after media import returns an asset ID. A CDN URL itself is not an OM asset and
should not be exposed to the agent.

Local cancellation proves neither vendor cancellation nor refund. Failed/unknown
jobs may incur charges. Preserve the existing job for reconciliation.

## Diagnose with evidence

For a plan gate, report the account/model restriction. A different model needs
a new intent, quote and approval path. Do not upgrade plans or silently change
providers. After reconnecting, resume status for the existing job rather than
repeating a possibly charging submit.

For an expired CDN link, get fresh status for the SAME job through admitted host
recovery. A terminal/unknown operation needs reconciliation, not silent reopening.
Read [failure modes](references/failure-modes.md) and
[model/plan evidence](references/models-and-plan-gates.md). Report observed host
diagnostics; an absent capability does not establish a particular vendor fault.
