# Lock groups (wave w22). Coordinator writes locks.txt in THIS ORDER (deadlock rule), then others alphabetically.
1 w14-alerts             apps/server/src/alerts/**, apps/server/src/composition/alerts.ts, alerts tests
2 w14-contracts          packages/contracts/** (Coordinator-integrated; builds that change contracts take it)
3 w13-server-composition apps/server/src/composition/*.ts except agent-plugin-backends.ts/workers.ts/alerts.ts (index.ts, reporting.ts, forms.ts, identity.ts, privacy.ts, catalog.ts, migrations.ts, serve.ts, integrations…)
4 w15-backends           apps/server/src/composition/agent-plugin-backends.ts (+ its tests)
5 w13-om-tools           apps/server/src/om-tools.ts, om-tool-coverage.ts, site-guide.ts, om-tools tests
6 w14-surface            apps/server/src/inbound/** (owner.ts, public.ts, integrations.ts), apps/server/src/cli/**, apps/studio/src/shared/api/**
7 w20-workers            apps/server/src/composition/workers.ts
others (alphabetical):
  w16-studio-chat        apps/studio/src/app/shell/**, studio chat widgets, workspace-canvas
  w16-web-events         features/web-events/**
  w18-google             content/agent-plugins/google-ads/**
  w14-gmeta-plugins      content/agent-plugins/meta-ads/**
  w18-leads              features/leads/**
  w19-contacts           features/contacts/**
  w20-measure            features/measure/**
  w20-tiktok             content/agent-plugins/tiktok-ads/**
  w20-twilio             content/agent-plugins/twilio-sms/**
  w20-approve-ui         apps/studio/src/features/approve/**
  w22-whatsapp           content/agent-plugins/whatsapp-business/**
  w22-forms              features/forms/**
  w22-studio-pages       apps/studio/src/pages/** not otherwise listed (integrations, tracking, measure, messages)
  w22-safety             features/safety/**
  w22-jobs               features/jobs/**
  w22-brand              features/brand/**
  w22-gbp                content/agent-plugins/google-business-profile/**
  w22-linkedin           content/agent-plugins/linkedin-ads/**
