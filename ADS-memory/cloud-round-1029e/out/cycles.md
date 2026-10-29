# Import cycles (dependency-cruiser no-cycles, same config as development/scripts/boundaries.mjs)

- Violation rows reported by cruiser: 53 (all distinct after rotation dedupe)
- Unique cycles (rotation-deduped): 53
- Cycles with at least one runtime edge: 41
- Fully type-only cycles (every edge type-only): 12
- Edges total: 193 (runtime 110, type-only 83)
- Note: boundaries.mjs also prints its own "cycle: <file>" lines (graphCycles DFS back-edges over TS-resolved edges, type-only included); those are a separate count in boundaries-raw.txt.

## Top 5 files by number of unique cycles
- 23  apps/server/src/composition/agent-plugin-backends.ts
- 20  apps/server/src/om-tools.ts
- 15  apps/server/src/composition/identity.ts
- 12  apps/server/src/composition/forms.ts
- 8  content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts

## By package

| package | cycles | runtime | fully type-only |
|---|---|---|---|
| apps/server | 24 | 24 | 0 |
| apps/studio | 1 | 0 | 1 |
| content/agent-plugins/amazon-ads | 1 | 1 | 0 |
| content/agent-plugins/google-ads | 2 | 1 | 1 |
| content/agent-plugins/line-ads | 1 | 0 | 1 |
| content/agent-plugins/meta-ads | 2 | 2 | 0 |
| content/agent-plugins/microsoft-ads | 3 | 3 | 0 |
| content/agent-plugins/pinterest-ads | 2 | 2 | 0 |
| content/agent-plugins/reddit-ads | 1 | 0 | 1 |
| content/agent-plugins/resend-email | 1 | 0 | 1 |
| content/agent-plugins/snapchat-ads | 8 | 6 | 2 |
| content/agent-plugins/twilio-sms | 3 | 1 | 2 |
| content/agent-plugins/vk-ads | 1 | 0 | 1 |
| content/agent-plugins/whatsapp-business | 1 | 0 | 1 |
| features/jobs | 1 | 0 | 1 |
| features/measure | 1 | 1 | 0 |

## apps/server

### Cycle 1 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/alerts/email.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/alerts/email.ts  [type-only]

### Cycle 2 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/alerts/email.ts  [type-only]

### Cycle 3 (6 files, 5 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 4 (6 files, 5 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 5 (4 files, 3 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 6 (7 files, 6 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/store.ts  [runtime]
- apps/server/src/alerts/store.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 7 (8 files, 7 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/jobs.ts -> apps/server/src/alerts/store.ts  [runtime]
- apps/server/src/alerts/store.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/jobs.ts  [runtime]

### Cycle 8 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]

### Cycle 9 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]

### Cycle 10 (7 files, 5 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 11 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 12 (7 files, 5 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/composition/reporting.ts  [runtime]
- apps/server/src/composition/reporting.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 13 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 14 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 15 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 16 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/tracking.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]

### Cycle 17 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]
- apps/server/src/inbound/public.ts -> apps/server/src/composition/forms.ts  [type-only]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]

### Cycle 18 (6 files, 3 runtime / 3 type-only edges) RUNTIME
- apps/server/src/conversations.ts -> apps/server/src/model-providers.ts  [runtime]
- apps/server/src/model-providers.ts -> apps/server/src/composition/addons.ts  [type-only]
- apps/server/src/composition/addons.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]
- apps/server/src/inbound/owner.ts -> apps/server/src/conversations.ts  [type-only]

### Cycle 19 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/inbound/integrations.ts -> apps/server/src/om-tools.ts  [type-only]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]
- apps/server/src/inbound/owner.ts -> apps/server/src/inbound/integrations.ts  [runtime]

### Cycle 20 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/messaging-webhooks.ts -> apps/server/src/composition/identity.ts  [type-only]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]
- apps/server/src/inbound/public.ts -> apps/server/src/inbound/messaging-webhooks.ts  [runtime]

### Cycle 21 (8 files, 6 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/owner.ts -> apps/server/src/composition/alerts.ts  [type-only]
- apps/server/src/composition/alerts.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]

### Cycle 22 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/public.ts -> apps/server/src/composition/identity.ts  [type-only]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]

### Cycle 23 (5 files, 4 runtime / 1 type-only edges) RUNTIME
- apps/server/src/inbound/public.ts -> apps/server/src/inbound/messaging-webhooks.ts  [runtime]
- apps/server/src/inbound/messaging-webhooks.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]

### Cycle 24 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/om-tools.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]

## apps/studio

### Cycle 25 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- apps/studio/src/shared/api/types.ts -> apps/studio/src/shared/api/validation.ts  [type-only]
- apps/studio/src/shared/api/validation.ts -> apps/studio/src/shared/api/types.ts  [type-only]

## content/agent-plugins/amazon-ads

### Cycle 26 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/google-ads

### Cycle 27 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/hosted.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts  [runtime]
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/hosted.ts  [runtime]

### Cycle 28 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/types.ts  [type-only]
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/types.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts  [type-only]

## content/agent-plugins/line-ads

### Cycle 29 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/meta-ads

### Cycle 30 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/audiences.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts  [runtime]
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/audiences.ts  [runtime]

### Cycle 31 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram.ts  [type-only]
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts  [runtime]

## content/agent-plugins/microsoft-ads

### Cycle 32 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 33 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]

### Cycle 34 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

## content/agent-plugins/pinterest-ads

### Cycle 35 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 36 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/reddit-ads

### Cycle 37 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/resend-email

### Cycle 38 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/snapchat-ads

### Cycle 39 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 40 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 41 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 42 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 43 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/metrics-status.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/metrics-status.ts  [runtime]

### Cycle 44 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

### Cycle 45 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

### Cycle 46 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]

## content/agent-plugins/twilio-sms

### Cycle 47 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 48 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [runtime]

### Cycle 49 (3 files, 0 runtime / 3 type-only edges) TYPE-ONLY
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts  [type-only]

## content/agent-plugins/vk-ads

### Cycle 50 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/whatsapp-business

### Cycle 51 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/transport.ts  [type-only]
- content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/ports.ts  [type-only]

## features/jobs

### Cycle 52 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- features/jobs/src/schema.ts -> features/jobs/src/types.ts  [type-only]
- features/jobs/src/types.ts -> features/jobs/src/schema.ts  [type-only]

## features/measure

### Cycle 53 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- features/measure/src/rules.ts -> features/measure/src/types.ts  [runtime]
- features/measure/src/types.ts -> features/measure/src/rules.ts  [type-only]
