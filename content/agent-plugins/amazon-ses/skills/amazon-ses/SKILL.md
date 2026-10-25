---
name: amazon-ses
description: Check OM's Amazon SES regional sending quota and configured domain readiness.
---

Use OM server tools account_status and domain_identity_status after owner connection/admission.
Ask the owner to enter IAM credentials and region through Integrations; never request secrets
in chat/tool arguments. Never use root keys. Identity setup and production access are manual.
Explain sandbox/quotas and failed verification/DKIM status; never call a domain check send approval.
R1 cannot send. Single/batch/segment sends, unsubscribe and feedback require later host wiring.
Future sends use OM contact IDs, current marketing consent and ONE server policy/outbox.
Bulk needs the exact card. Erased/suppressed/withdrawn contacts cannot receive marketing.
Keep tracking off. Never retry ambiguous SES sends; report reconciliation required.
