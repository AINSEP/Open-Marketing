# Failure modes

Adapted from Tovu's Apache-2.0 same-path reference for OM, 2026-10-12.
September observations are historical, not current vendor acceptance evidence.

| Observation | Meaning and action |
| --- | --- |
| Capability absent/denied | Read current host connection/admission diagnostics. Enablement, OAuth and admission are separate; absence alone does not establish the cause. |
| Authorization expired/revoked | Owner reconnects. Each poll uses current broker authority. Resume the existing job; do not repeat a possibly charging submit. |
| `Requires basic plan or higher` / upgrade intent | Account plan restriction. Quote success does not override it. Do not retry unchanged requests or invoke billing/upgrade tools. |
| Synchronous status timeout | Tovu observed 25-second vendor waiting against a 15-second call ceiling. OM uses asynchronous polling; that historical transport defect is not an OM guarantee. |
| Generic internal error | Cause may have been lost upstream. Report the typed host diagnostic/unknown state; do not invent a cause or regenerate. |
| Status stays pending | Respect delay, attempt cap and absolute deadline. Timeout means effect/cost may be unknown, not zero/refunded. |
| Completed status without one structured image link | Protocol mismatch. Text URLs are insufficient proof. Preserve the job and reconcile. |
| CDN 403/404 | Often an expired signed URL. Obtain a fresh reference for the SAME job through host recovery, without regenerating. |
| Guarded media refusal | Preserve DNS/redirect/MIME/byte/completeness checks. Do not work around them by unsafe download/reupload. |
| No library asset after submission | A job or CDN URL is insufficient. Verify completed status AND a successful media import with an asset ID. |
| Cost append fails or actual amount changes | Retain exposure and job identity. Append-only corrections need reconciliation; do not overwrite amounts or infer refunds. |

There is no automatic generation retry or alternative-provider/model fallback.
