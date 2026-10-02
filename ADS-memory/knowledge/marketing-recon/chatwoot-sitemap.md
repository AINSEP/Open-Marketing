# Chatwoot Behavioral Site Map

> How Chatwoot actually *runs*, not how its files are arranged. Companion to
> `chatwoot-architecture.md` (structural analysis — node/edge counts, Leiden
> clusters, complexity, license split, cycles, betweenness, port-target
> ranking). This document does not repeat that content.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/chatwoot`, commit `926a9d8a` (branch `develop`)
> - **Method:** cbm project `chatwoot` (indexed 2026-09-06, moderate mode) for schema/route
>   discovery, cross-checked against direct `rg`/file reads for every claim that matters.
>   graphify was consulted for the ActionCable/Channel-node question only (see §9).
> - **Date:** 2026-09-06

## Tool-trap note (read before trusting any number below)

cbm's `Route` node extraction on this Rails DSL is unreliable: `MATCH (r:Route) RETURN
r.file_path, count(r)` puts 346 of 364 Route nodes at `file_path: ""`, and pulling
`r.method`/`r.key_path` for those 346 returns empty strings for the great majority (spot
check: 8 non-empty methods out of 346 rows). **Do not cite cbm Route counts or key_paths for
this repo.** Every endpoint-family size below is instead a hand count from reading
`config/routes.rb` directly (726 lines, read in full) plus a controller-file-count proxy
(`find app/controllers/... -name '*.rb' | wc -l`) as a second, independent signal. Both are
cited; treat the route-block hand count as approximate (nested `resources`/`member`/
`collection` blocks are easy to miscount by a few) and the controller count as exact but a
proxy (one controller can serve 2-7 actions).

## 1. HTTP surface map

Single `config/routes.rb`, 726 lines, no separate engine route files — `enterprise/` adds
routes *inline* via `if ChatwootApp.enterprise?` guards in the same file, it does not mount
its own routes file (confirmed: `find enterprise -iname routes.rb` → no results).

| Family | Routes block | Controllers (proxy) | Approx. endpoints | Auth | License |
|---|---|---|---|---|---|
| `/api/v1/accounts/:account_id/*` (agent-facing CRUD) | routes.rb:47-413 | `app/controllers/api/v1/accounts/` — 70 files | ~180-220 (dominant family: conversations+messages nesting alone is ~25, portals ~20, captain ~35-40) | `Api::BaseController` (routes.rb-independent): `authenticate_user!` via devise_token_auth (`Authorization`/`access-token`+`client`+`uid` headers) **or** `api_access_token` header for AgentBot tokens (`app/controllers/api/base_controller.rb:4-6`) | MIT, except `captain/*` (routes.rb:64-95), `whatsapp_calls` (240-251), enterprise `csat_survey_responses#update` (228), inbox `conference`/calling routes (265-272) — all gated `if ChatwootApp.enterprise?` |
| `/api/v1/*` non-account (profile, widget config, integrations webhook, SAML) | routes.rb:418-478 | 4 top-level + `widget/` (11 files) | ~35 | same devise_token_auth for profile/notifications; **widget namespace is unauthenticated by account** (see §9) | MIT |
| `/api/v2/accounts/:account_id/*` (reporting/analytics) | routes.rb:481-519 | `app/controllers/api/v2/` — 5 files | ~20 (summary_reports 5, reports 13, year_in_review 1, live_reports 2) | same as v1 accounts | MIT |
| `/enterprise/api/v1/*` (billing) | routes.rb:522-540 | inside `enterprise/app/controllers` (56 files total, shared with overrides below) | ~12 (accounts CRUD+5 member actions, 2 Stripe/Firecrawl webhooks) | devise_token_auth, admin-gated | Enterprise |
| `/platform/api/v1/*` (Platform API — SSO/provisioning for embedding Chatwoot in another product) | routes.rb:545-567 | `app/controllers/platform/` — 5 files | ~21 (users 6, agent_bots 6, accounts 5+account_users 3+email_channel_migrations 1) | **Not devise** — `PlatformController#ensure_access_token` looks up an `AccessToken` row by `api_access_token` header, owner must be a `PlatformApp` (`app/controllers/platform_controller.rb:17-25`) | MIT |
| `/public/api/v1/*` (widget-adjacent, contact-facing REST) | routes.rb:571-593 + `hc/*` help-center routes 595-606 | `app/controllers/public/` — 10 files | ~15 (inbox→contact→conversation→message nesting) + 9 help-center routes | **No token at all** — `PublicController` has no auth before_action; access control is entirely through unguessable `inbox_id`/`contact_id`/conversation `uuid` in the URL, optionally HMAC-verified per contact (`app/controllers/public_controller.rb`) | MIT |
| Widget-facing (`namespace :widget` under api/v1) | routes.rb:447-478 | `api/v1/widget/` — 11 files | ~23 | `WebsiteTokenHelper` (widget's `website_token`) + contact identified via cookie/local pubsub token, not a bearer credential (`app/controllers/api/v1/widget/base_controller.rb:1-9`) | MIT |
| Inbound webhooks (per-channel provider callbacks) | routes.rb:618-653 | `app/controllers/webhooks/` — 7 files (+ `Facebook::Messenger::Server` gem mount, + `api/v1/webhooks` for Twitter) | ~16-18 | Per-provider signature verification (Meta HMAC, Twilio signature, etc.) — see §2/§2-table | MIT |
| `super_admin/*` (ChatWoot ops console) | routes.rb:672-711 | `app/controllers/super_admin/` — 15 files | ~55-60 (accounts 9, users 8, agent_bots 8, platform_apps 7, platform_banners 7 full CRUD, installation_configs 5, access_tokens 2, app_config/push_diagnostics/settings/instance_status ~7, account_users 4) + mounts `Sidekiq::Web` at `/monitoring/sidekiq` gated behind `authenticated :super_admin` | Separate `devise_for :super_admins` (routes.rb:672) | MIT |
| Misc (OAuth callbacks, `.well-known/*`, swagger, installation onboarding, `widget_tests`) | routes.rb:608-664, 713-726 | scattered | ~18 | mixed (OAuth callbacks are unauthenticated redirect targets keyed by state) | MIT |

**Total controller files:** 70+4+5+5+5+10+15+11+7 (core) + 56 (enterprise, many of which
*reopen* core controllers via `prepend_mod_with` rather than adding new ones) ≈ 130 core +
56 enterprise-touching files.

## 2. Inbound message path, end to end — WhatsApp Cloud

Traced for the Meta "WhatsApp Cloud API" provider (the newer of the two WhatsApp providers;
the other is legacy 360dialog, same base class).

1. **Webhook receipt.** `POST webhooks/whatsapp/:phone_number` (`config/routes.rb:625`) →
   `Webhooks::WhatsappController#process_payload`
   (`app/controllers/webhooks/whatsapp_controller.rb:6-15`). `before_action
   :verify_meta_signature!` (from `MetaTokenVerifyConcern`) runs first; the controller does
   almost nothing itself — it checks an inactive-number denylist, then
   `Webhooks::WhatsappEventsJob.perform_later(params.to_unsafe_hash)` and returns `200 OK`
   immediately. **All real processing is deferred to Sidekiq** (queue `low`).

2. **Job dispatch + dedup.** `Webhooks::WhatsappEventsJob#perform`
   (`app/jobs/webhooks/whatsapp_events_job.rb:9-25`): resolves the `Channel::Whatsapp` row
   from the payload (`find_channel_from_whatsapp_business_payload`, lines 133-149), checks
   `channel_is_inactive?`, then — if the payload carries a contact identifier — acquires a
   30s Redis mutex keyed `(inbox_id, sender_id)` (`Redis::Alfred::WHATSAPP_MESSAGE_MUTEX`,
   line 24) before calling `process_events`. The mutex exists specifically because WhatsApp
   album uploads fire multiple concurrent webhooks for one logical message
   (comment at lines 20-23). `process_events` (27-33) branches on `message_echo_event?` (a
   WhatsApp-Business-app-side send synced back to Chatwoot, "coexistence") vs. a regular
   inbound event, and further on `channel.provider` (whatsapp_cloud vs. 360dialog).

3. **Message builder.** `Whatsapp::IncomingMessageWhatsappCloudService`
   (`app/services/whatsapp/incoming_message_whatsapp_cloud_service.rb`) extends
   `Whatsapp::IncomingMessageBaseService`
   (`app/services/whatsapp/incoming_message_base_service.rb`) and overrides only
   `processed_params` (payload unwrapping, lines 7-9) and `download_attachment_file`
   (Meta media API, lines 11-28). All the real logic lives in the base class:
   - `perform` (10-18) branches on `statuses` (delivery-status webhook, §3) vs. `messages`
     (new inbound message).
   - `process_messages` (27-47): skips unsupported message types, uses an atomic Redis
     `SET NX` (`lock_message_source_id!`) as a second, message-level dedup layer, then
     `set_contact` → `set_conversation` → `create_messages`, the last two inside an
     `ActiveRecord::Base.transaction`.
   - `set_conversation` (115-126): reuses the last conversation on the `ContactInbox` if
     `inbox.lock_to_single_conversation`, else the last non-resolved one, else
     `Conversation.create!`.
   - `create_message` (161-173): `@conversation.messages.build(... message_type: :incoming,
     status: :sent, sender: @contact, source_id: ..., content_attributes: ...)` — this is
     the literal `Message` row creation. Attachments/location/contact-card payloads are
     attached in `attach_files`/`attach_location`/`attach_contact` before `@message.save!`.

4. **Message model callbacks → dispatch.** Saving the `Message` triggers
   `execute_after_create_commit_callbacks` (`app/models/message.rb:324-333`), which calls
   `dispatch_create_events` (378-387): `Rails.configuration.dispatcher.dispatch(MESSAGE_CREATED,
   Time.zone.now, message: self, performed_by: Current.executed_by)`, and
   `FIRST_REPLY_CREATED` if this is the first reply in the conversation. `Conversation`
   creation similarly dispatches `CONVERSATION_CREATED` (`app/models/conversation.rb:295`).

5. **Dispatcher fan-out.** `Dispatcher` (`app/dispatchers/dispatcher.rb`) is a `Singleton`
   holding a `SyncDispatcher` and an `AsyncDispatcher`; `dispatch` calls both, synchronously,
   in-process (no queue in between — "async" here means "wisper-style pub/sub", not
   "backgrounded"). Listeners are registered at boot via
   `config/initializers/event_handlers.rb:3-4` (`Dispatcher.instance.load_listeners`). 12
   listener classes subscribe by defining a method named after the event (`message_created`,
   `conversation_created`, etc.) — see §5.

6. **ActionCable push.** `ActionCableListener#message_created`
   (`app/listeners/action_cable_listener.rb:41-47`) computes the token list — agent/admin
   `pubsub_token`s on the inbox (`user_tokens`) plus the contact's `pubsub_token` (unless the
   message is private/activity) — and calls `broadcast`, which enqueues
   `ActionCableBroadcastJob.perform_later(tokens, event_name, payload)` (queue `critical`,
   line 230). The job (`app/jobs/action_cable_broadcast_job.rb:33-43`) loops the token list
   and calls `ActionCable.server.broadcast(member, { event:, data: })` **once per
   `pubsub_token` stream**, not once per account — each browser tab subscribes its own
   stream keyed by its `pubsub_token` (see §9).

7. **Dashboard receipt.** `BaseActionCableConnector`
   (`app/javascript/shared/helpers/BaseActionCableConnector.js:17-24`) opens one
   `@rails/actioncable` consumer per session, subscribed to `RoomChannel` with its
   `pubsub_token`. `ActionCableConnector` (`app/javascript/dashboard/helper/actionCable.js`)
   maps `'message.created'` → `onMessageCreated` (lines 29, 116-127), which dispatches Vuex
   `addMessage` and `updateConversationLastActivity`.

### Where the other 11 channels diverge

| Channel | Entry point | Dedup/lock | Builder |
|---|---|---|---|
| WhatsApp (360dialog) | same controller/job as Cloud | same mutex | `Whatsapp::IncomingMessageService` (no override — pure base class) |
| Facebook Page | `mount Facebook::Messenger::Server, at: 'bot'` (routes.rb:618) — the `facebook-messenger` gem's own Rack app, **not a Chatwoot controller** | gem-internal | `Messages::Facebook::MessageBuilder` (`app/builders/messages/facebook/message_builder.rb`), invoked from a `Facebook::Messenger` bot-hook callback, not a job |
| Instagram (Story replies via Meta Graph webhook) | `GET/POST webhooks/instagram` (626-627) → `Webhooks::InstagramController` → `Webhooks::InstagramEventsJob` | job-level, not the WhatsApp Redis mutex | `Messages::Instagram::MessageBuilder` / `Messages::Instagram::Messenger::MessageBuilder` |
| Twitter (DMs, being sunset) | `GET/POST webhooks/twitter` → `Api::V1::WebhooksController#twitter_crc`/`#twitter_events` (619-620) — CRC handshake is a distinct GET route, unlike every other provider | n/a | `Messages::Messenger::MessageBuilder` |
| Telegram | `POST webhooks/telegram/:bot_token` (622) → `Webhooks::TelegramController` → `Webhooks::TelegramEventsJob` | job-level | `Telegram::IncomingMessageService` |
| Line | `POST webhooks/line/:line_channel_id` (621) → `Webhooks::LineController` → `Webhooks::LineEventsJob` | job-level | `Line::IncomingMessageService` |
| SMS (generic) | `POST webhooks/sms/:phone_number` (623) → `Webhooks::SmsController` → `Webhooks::SmsEventsJob` | job-level | `Sms::IncomingMessageService` |
| Twilio SMS | `namespace :twilio; resources :callback` (643-644) | job-level | `Twilio::IncomingMessageService` |
| TikTok | `POST webhooks/tiktok` (628) → `Webhooks::TiktokController` → `Webhooks::TiktokEventsJob` | job-level | `Tiktok::MessageService` (no separate incoming/outgoing split — one service handles both directions) |
| Email | **No webhook at all.** `Inboxes::FetchImapEmailInboxesJob` polls IMAP every minute (`config/schedule.yml`, `trigger_imap_email_inboxes_job`), fans out to `Inboxes::FetchImapEmailsJob` per inbox | Message-ID based | mail parsing in `app/services` (`Mailboxes::*`, not traced in depth here) |
| Web Widget | **No webhook, no job.** `Api::V1::Widget::MessagesController#create` (`app/controllers/api/v1/widget/messages_controller.rb:8-12`) builds the `Message` directly and synchronously in the request: `conversation.messages.new(message_params); @message.save!` | none needed (single HTTP request per message) | none — controller does the work `IncomingMessageBaseService` does elsewhere |
| Api channel | Same pattern as Web Widget but through `Public::Api::V1::Inboxes::MessagesController#create` (`app/controllers/public/api/v1/inboxes/messages_controller.rb:7-11`) — this **is** the channel: any external system can be a "channel" by POSTing here | none | controller-inline, same as Web Widget |

**Pattern:** every provider that requires webhook-signature verification and payload
translation gets Controller→Job→`*IncomingMessageService` (or `*MessageBuilder`); every
channel that is inherently a direct API call (Web Widget, Api, and outbound-only Twitter/FB
in newer flows) skips the job/service layer and builds the `Message` inline in the request
controller. Facebook is the outlier: it doesn't use Chatwoot's router at all, delegating to
the `facebook-messenger` gem's mounted Rack app.

## 3. Outbound message path, end to end

1. **Trigger.** Any `Message` create/update that is `outgoing` and not itself sourced from a
   channel calls `send_reply` from the same `execute_after_create_commit_callbacks` chain as
   inbound (`app/models/message.rb:330`, `397-401`): `SendReplyJob.perform_later(id)`
   (queue `high`), delayed 2s if the message has attachments (comment: ActiveStorage attaches
   post-commit).

2. **Router.** `SendReplyJob#perform` (`app/jobs/send_reply_job.rb`) loads the message,
   reads `message.conversation.inbox.channel.class.to_s`, and looks it up in a hardcoded
   `CHANNEL_SERVICES` hash (lines 4-16) mapping each `Channel::*` class to a
   `*::SendOn*Service`. Facebook is special-cased outside the hash (lines 20-27) because one
   `Channel::FacebookPage` inbox can carry either genuine FB Messenger or Instagram Direct
   conversations, disambiguated by `conversation.additional_attributes['type']`.

3. **Shared base.** Every per-channel send service extends `Base::SendOnChannelService`
   (`app/services/base/send_on_channel_service.rb`, `in_degree: 11` in the graph — the
   highest fan-in of any class in the repo, confirming it as the real chokepoint for
   outbound). `perform` (13-19): `validate_target_channel` (raises if the inbox's channel
   class doesn't match — a hard contract check), skip if not `outgoing_message?`, skip if
   `invalid_message?` (private notes, messages that originated *from* the channel — loop
   prevention — or `voice_call` content-type bubbles), then `perform_reply` (abstract,
   overridden per channel).

4. **Per-channel send.** For WhatsApp (`app/services/whatsapp/send_on_whatsapp_service.rb`):
   `perform_reply` (8-15) decides template-vs-session message
   (`message.conversation.can_reply?` — WhatsApp's 24-hour session window rule) and calls
   either `channel.send_template` or `channel.send_message`, both `delegate`d
   (`app/models/channel/whatsapp.rb:109-113`) to `provider_service`
   (`Whatsapp::Providers::WhatsappCloudService` or `...Whatsapp360DialogService`, chosen by
   `provider` column, lines 64-70).

5. **Provider API call.** `Whatsapp::Providers::WhatsappCloudService#send_template`
   (`app/services/whatsapp/providers/whatsapp_cloud_service.rb:17-30`): builds a
   `messaging_product: 'whatsapp'` JSON body and `HTTParty.post("#{phone_id_path}/messages",
   headers: api_headers, body: ...)` directly against the Meta Graph API — **no queue, no
   retry wrapper** at this layer; failure handling is a plain `process_response` call.
   `send_message` variants (text/attachment/interactive) live in the same file.

6. **Delivery-status handling.** Meta posts delivery/read receipts back through the *same*
   webhook (`webhooks/whatsapp/:phone_number`) as inbound messages — there is no separate
   status endpoint. `IncomingMessageBaseService#process_statuses`
   (`app/services/whatsapp/incoming_message_base_service.rb:49-57`) finds the existing
   `Message` by `source_id` and calls `update_message_with_status` (59-66), which sets
   `message.status` and, on `failed`, `external_error` from Meta's error payload, then
   `message.save!` — this triggers `MESSAGE_UPDATED` dispatch → `ActionCableListener
   #message_updated` (54) → same broadcast path as creation. Twilio has an analogous but
   separate route: `POST twilio/delivery_status` (routes.rb:645) →
   `Webhooks::TwilioDeliveryStatusJob`, because Twilio's callback URL is distinct from its
   inbound-message URL (unlike Meta's single-webhook design).

## 4. Async/background layer

**82 job classes in `app/jobs/`, 36 in `enterprise/app/jobs/`** (`find ... -name '*.rb' | wc
-l`, both counts exact).

Queues, from `config/sidekiq.yml` (priority order, no explicit weights — Sidekiq processes
strictly in listed order when a higher queue has work):
`critical > high > medium > default > mailers > action_mailbox_routing > low >
scheduled_jobs > deferred > purgable > housekeeping > async_database_migration >
bulk_reindex_low > active_storage_analysis > active_storage_purge >
action_mailbox_incineration`. Concurrency: `ENV['SIDEKIQ_CONCURRENCY']` default 10.

**Hot-path (request-adjacent) jobs**, by observed queue:
- `critical`: `ActionCableBroadcastJob` — every realtime push goes through this queue.
- `high`: `SendReplyJob` — every outbound message.
- `low`: `Webhooks::WhatsappEventsJob` and siblings (webhook ingestion) — despite being
  "low" priority in Sidekiq's sense, this is the entire inbound path; "low" here reflects
  Chatwoot's own priority choice (webhooks can tolerate a few seconds of queueing;
  dashboard broadcasts cannot), not that it's non-critical to the product.

**Periodic (cron) jobs**, from `config/schedule.yml` (`sidekiq-cron`, 11 entries, 1
commented out/disabled):

| Job | Cadence | Purpose |
|---|---|---|
| `TriggerScheduledItemsJob` | `*/5 * * * *` | fans out due one-off campaigns (`Campaign.where(campaign_type: :one_off, campaign_status: :active, scheduled_at: 3.days.ago..now)`), plus reopen-snoozed-conversation/notification and auto-resolve triggers — see §8 |
| `Inboxes::FetchImapEmailInboxesJob` | `*/1 * * * *` | IMAP polling, the Email channel's only inbound path |
| `Internal::TriggerHourlyScheduledItemsJob` | `0 * * * *` | empty in core (`app/jobs/internal/trigger_hourly_scheduled_items_job.rb:4`) — pure extension point, `prepend_mod_with` |
| `Internal::TriggerDailyScheduledItemsJob` | `0 0 * * *` | schedules `Internal::CheckNewVersionsJob` at an installation-specific minute (`Digest::MD5.hexdigest(installation_id).hex % 1440`, line 23) to spread load across self-hosted instances |
| `AutoAssignment::PeriodicAssignmentJob` | `*/30 * * * *` | assignment-v2 rebalancing |
| `Internal::RemoveStaleContactInboxesJob`, `Internal::RemoveStaleRedisKeysJob`, `Notification::RemoveOldNotificationJob` | `30 22 * * *` (all three, same slot — Chatwoot's "lowest traffic time") | housekeeping |
| `Internal::DeleteAccountsJob` | `0 1 * * *` | GDPR-style deferred account deletion |
| `Internal::RemoveOrphanConversationsJob` | `0 */12 * * *` | housekeeping |
| `Internal::ProcessStaleContactsJob` | *(commented out — disabled, comment says "investigating if this job is the source of orphan conversations")* | — |

**Enterprise hooks into the same cron slots via `prepend_mod_with`**, not separate cron
entries: `Enterprise::TriggerScheduledItemsJob#perform` (`enterprise/app/jobs/enterprise/
trigger_scheduled_items_job.rb`) calls `super` then adds `Sla::TriggerSlasForAccountsJob`;
`Enterprise::Internal::TriggerDailyScheduledItemsJob` calls `super` then schedules
`Captain::Documents::ScheduleSyncsJob` for `'enterprise'` tier always, `'business'` tier on
Sundays, `'startups'` tier on the 1st of the month. This module-prepend pattern (core class
calls `ClassName.prepend_mod_with('ClassName')` at the bottom of its own file — see
`app/jobs/trigger_scheduled_items_job.rb` bottom line, `webhooks/whatsapp_events_job.rb`
bottom line) is the **general enterprise-extension mechanism** for jobs, distinct from the
routes.rb `if ChatwootApp.enterprise?` guard used for HTTP endpoints.

## 5. Event and listener bus

**Dispatch mechanism, precisely:** `Dispatcher` (`app/dispatchers/dispatcher.rb`) is a
`Singleton` set on `Rails.configuration.dispatcher` at boot
(`config/initializers/event_handlers.rb:3-4`, inside `config.to_prepare`). It is **not**
ActiveSupport::Notifications and **not** a message queue — it wraps two custom classes,
`SyncDispatcher` and `AsyncDispatcher` (not read in full; both expose `dispatch` and
`load_listeners`), and calls both synchronously in the same method
(`app/dispatchers/dispatcher.rb:15-18`). "Async" in the class name refers to a Wisper-style
listener-registration pattern, not to backgrounding — no Sidekiq job is enqueued by the
dispatch call itself (individual listeners, like `ActionCableListener`, enqueue their own
jobs). Models call it directly: `Rails.configuration.dispatcher.dispatch(EVENT_CONST,
Time.zone.now, **data)` — over 20 call sites across `app/models/*.rb` and
`app/services/**/*.rb` (grepped, not exhaustively enumerated here).

**12 listeners in `app/listeners/`, all subclass `BaseListener`** (`Singleton`, provides
`extract_*_and_account` helpers, `app/listeners/base_listener.rb`):

| Listener | Subscribes to (method names = event names) | Action |
|---|---|---|
| `ActionCableListener` | `message_created`/`updated`, `conversation_created`/`updated`/`read`/`status_changed`/`typing_on`/`typing_off`/`contact_changed`/`unread_count_changed`/`mentioned`, `contact_created`/`updated`/`merged`/`deleted`, `notification_created`/`updated`/`deleted`, `assignee_changed`, `team_changed`, `account_cache_invalidated`, `first_reply_created` (23 methods total) | Computes recipient `pubsub_token`s, enqueues `ActionCableBroadcastJob` (§2 step 6) |
| `AutomationRuleListener` | `conversation_created`/`updated`/`opened`/`resolved`, `message_created` | Runs matching `AutomationRule`s (§7) |
| `CampaignListener` | `campaign_triggered` | Builds the conversation for an "ongoing" campaign (§8) |
| `WebhookListener` | (not read in full; account-level outbound webhooks, `webhooks` table `subscriptions` jsonb) | Enqueues `WebhookJob` per subscribed URL |
| `HookListener` | integration hooks (Slack/Dyte/etc.) | fires `Integrations::Hook` callbacks |
| `NotificationListener` | conversation/message/mention events | Creates `Notification` rows (which themselves dispatch `NOTIFICATION_CREATED`, consumed again by `ActionCableListener` — a two-hop fan-out) |
| `AgentBotListener` | conversation/message events on AgentBot-owned inboxes | Forwards to the bot's webhook |
| `ParticipationListener` | conversation participant changes | maintains `conversation_participants` |
| `CsatSurveyListener` | conversation resolved | triggers CSAT survey message send |
| `ReportingEventListener` | conversation/message lifecycle events | writes `ReportingEvent` rows (§6) |
| `InstallationWebhookListener` | account/install-level events | Chatwoot-Hub telemetry |
| (12th — `base_listener.rb` itself is infra, not a subscriber) | — | — |

Event name constants live in `lib/events/types.rb` (e.g. `CAMPAIGN_TRIGGERED =
'campaign.triggered'`, `MESSAGE_CREATED`, etc.) and are `include`d into both the dispatching
model/service and the listener, so the same Ruby constant is used on both ends (not a
stringly-typed event bus, despite dispatch taking a string under the hood).

## 6. Data model / schema map

From `db/schema.rb` (`ActiveRecord::Schema[7.1]`, version `2026_06_20_000000`, Postgres
extensions: `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `plpgsql`, **`vector`** — pgvector is
enabled at the schema level for Captain's embeddings, enterprise-only).

| Table | Key columns | jsonb columns (shape) | Indexes revealing access pattern |
|---|---|---|---|
| `accounts` | `feature_flags:bigint` (bitfield), `status` | `limits`, `custom_attributes`, `internal_attributes`, `settings` — all opaque `{}` | `status` only — accounts are looked up by FK from everywhere else, not scanned |
| `contacts` | `account_id`, `contact_type` enum (`visitor/lead/customer`), `blocked:boolean`, `company_id` | `additional_attributes` (browser/referrer metadata, set on creation), `custom_attributes` (tenant-defined CDP fields) | `gin_trgm_ops` on `(name, email, phone_number, identifier)` for fuzzy search; **partial index** `index_resolved_contact_account_id` `where` any identifying field is non-empty (query-shape hint: most lookups filter out "headless" contacts); unique `(email, account_id)` and `(identifier, account_id)` |
| `contact_inboxes` | `contact_id`, `inbox_id`, `source_id` (the channel-native id — phone number, PSID, etc.), `pubsub_token` | — | unique `(inbox_id, source_id)` — this is the actual identity join for "same contact writing again on this channel"; unique `pubsub_token` (ActionCable identity, see §9) |
| `conversations` | `status`, `assignee_id`, `display_id` (per-account sequence), `uuid`, `priority`, `sla_policy_id`, `waiting_since`, `cached_label_list:text` (denormalized) | `additional_attributes`, `custom_attributes` | composite `(account_id, inbox_id, status, assignee_id)` — the literal inbox-view query; `(status, priority)`; `waiting_since` alone (SLA/reply-time queries) |
| `messages` | `message_type` (incoming/outgoing/activity/template), `content_type`, `private:boolean`, `status`, `source_id`, `sender_type/sender_id` (polymorphic) | `content_attributes` (`automation_rule_id`, `in_reply_to_external_id`, `external_echo`, referral data — the "why was this sent" metadata), `additional_attributes` (`campaign_id` lives here, not a real FK — see §8), `sentiment`, `external_source_ids` | **GIN index on `(additional_attributes -> 'campaign_id')`** — confirms campaign attribution is a jsonb-key lookup, not a join; `gin_trgm_ops` on `content` for full-text-ish search; `(conversation_id, account_id, message_type, created_at)` — timeline queries |
| `campaigns` | `campaign_type` enum (`ongoing/one_off`), `campaign_status` enum (`active/completed/processing`), `sender_id`, `inbox_id` | `trigger_rules` (`{url, time_on_page}` for ongoing), `audience` (array of `{type: 'Label', id}`), `template_params` | no index on `campaign_status` + `campaign_type` combined — `TriggerScheduledItemsJob`'s query (`campaign_type: :one_off, campaign_status: :active, scheduled_at: range`) hits three single-column indexes, not a composite |
| `automation_rules` | `event_name`, `active:boolean` | `conditions` (array of `{attribute_key, filter_operator, values, query_operator}`), `actions` (array of `{action_name, action_params}`) — both default `"{}"` despite being conceptually arrays | single index on `account_id` only — `AutomationRuleListener` filters `event_name`+`account_id`+`active` in Ruby/SQL `where` with no supporting composite index |
| `labels` | `title`, `color`, `show_on_sidebar` | — | unique `(title, account_id)` |
| `custom_attribute_definitions` | `attribute_model` (contact/conversation), `attribute_display_type`, `regex_pattern`/`regex_cue` (validation, a nice small detail) | `attribute_values` (enum options for select-type attributes) | unique `(attribute_key, attribute_model, account_id)` |
| `inboxes` | `channel_id` + `channel_type` (**polymorphic** — there is no single `channels` table; each channel type is its own table, see below) | `auto_assignment_config`, `csat_config` | `(channel_id, channel_type)` — the polymorphic lookup |
| **Channel tables** (12, one per type) | e.g. `channel_whatsapp`: `phone_number` (unique), `provider` (`default`/`whatsapp_cloud`) | `provider_config` (API keys, webhook tokens — **secrets live in this jsonb column, not a vault**), `message_templates` | each has its own narrow index set; no shared `channels` table to index once |
| `webhooks` | `account_id`, `inbox_id`, `webhook_type`, `secret` | `subscriptions` (array of event-name strings, defaults to 8 named events) | unique `(account_id, url)` |
| `reporting_events` | `name`, `value`, `value_in_business_hours`, `account_id`/`inbox_id`/`user_id`/`conversation_id` (all plain FKs, no jsonb) | none — this is the raw event-log table | `(account_id, name, created_at)` and a dedicated `(account_id, name, inbox_id, created_at)` index named for "response distribution" — built specifically for a histogram query |
| `reporting_events_rollup` | `dimension_type`/`dimension_id` (polymorphic-by-string, not a Rails polymorphic association), `metric`, `date`, `count`, `sum_value`, `sum_value_business_hours` | none | unique `(account_id, date, dimension_type, dimension_id, metric)` — one row per day per dimension per metric, i.e. a pre-aggregated daily rollup table fed by a separate job (not traced here) |
| `taggings` (acts-as-taggable-on) | `tag_id`, `taggable_type`/`taggable_id`, `context` | — | this is how `labels` actually attach to `conversations` — automation rules' label filters join through here (§7) |

## 7. Automation rule execution, traced

1. **Trigger.** A conversation or message event fires (§5). `AutomationRuleListener`
   (`app/listeners/automation_rule_listener.rb`) has one method per subscribed event; all
   funnel into `process_conversation_event` (39-57) or the `message_created`-specific path
   (18-35). Both guard against **infinite loops**: `performed_by_automation?` (73-75) checks
   `event.data[:performed_by].instance_of?(AutomationRule)` — set by
   `AutomationRules::ActionService#initialize` via `Current.executed_by = rule` (line 6) — so
   an automation-triggered update can't re-trigger the same class of rule.

2. **Rule lookup.** `current_account_rules` (65-71): a plain
   `AutomationRule.where(event_name:, account_id:, active: true)` — **no scoping to which
   conversation/inbox** at the SQL level; every active rule for the event+account is loaded
   and evaluated in Ruby, one at a time (line 53 `rules.each`).

3. **Condition evaluation → SQL.** `AutomationRules::ConditionsFilterService`
   (`app/services/automation_rules/conditions_filter_service.rb`) extends the shared
   `FilterService` (used elsewhere for saved conversation filters — the automation condition
   language and the "custom view" filter language are **the same engine**, confirmed by the
   `< FilterService` inheritance at line 3). `perform` (25-44):
   - validates the rule via `ConditionValidationService` first (line 26) — an invalid rule
     gets `@rule.authorization_error!` and is skipped, not crashed.
   - iterates `@rule.conditions` (the jsonb array), building a parameterized SQL string
     fragment per condition via `apply_filter` (63-77), which dispatches to
     `conversation_query_string`/`contact_query_string`/`message_query_string`/
     `custom_attribute_query` based on which of three YAML-defined filter dictionaries
     (`lib/filters/filter_keys.yml`, loaded at line 14) the `attribute_key` belongs to.
   - **Concretely, jsonb → SQL:** for a `standard` conversation attribute it emits
     `" conversations.#{attribute_key} #{op} :value_N "` (line 157); for an
     `additional_attributes` type it emits `" conversations.additional_attributes ->>
     '#{attribute_key}' #{op} :value_N "` (line 152) — literal Postgres jsonb `->>` operator
     interpolation, string-built then executed as one combined `.where(@query_string,
     @filter_values)` (line 36) against a `base_relation` that pre-joins `contacts`,
     `messages`, and (only if a label condition exists) `taggings`/`tags` (187-205). Label
     conditions get special-cased SQL (`build_label_query_string`, 162-183) since labels
     aren't a column but a `taggings` join.
   - `attribute_changed` filters (a condition type meaning "X went from A to B") are pulled
     out of the SQL path entirely and evaluated against `event.data[:changed_attributes]` in
     Ruby (`perform_attribute_changed_filter`, 81-109) — the one condition type that can't be
     expressed as a WHERE clause because it needs the event's diff, not current state.
   - Final check is `records.any?` (line 39) — the whole apparatus exists to answer one
     boolean question per rule per event.

4. **Action execution.** `AutomationRules::ActionService`
   (`app/services/automation_rules/action_service.rb`) extends a shared `ActionService`
   (not read in full; likely also shared with macros — `MacrosExecutionJob` almost certainly
   reuses the same action vocabulary, not confirmed). `perform` (9-21): iterates
   `@rule.actions` (jsonb array of `{action_name, action_params}`), `@conversation.reload`s
   before each (defends against one action's side effect stale-reading in the next), and
   dynamically dispatches `send(action[:action_name], action[:action_params])` — **21
   possible action names are Ruby method names on this class**, called by string dispatch
   from user-configured jsonb. Errors per-action are caught and sent to
   `ChatwootExceptionTracker`, not raised — one bad action doesn't abort the rest. Concrete
   actions read: `send_message`/`add_private_note` both go through
   `Messages::MessageBuilder.new(nil, @conversation, params).perform` — i.e. an
   automation-sent message is built through **the same builder outbound human replies use**,
   just with `sender: nil` and `content_attributes: {automation_rule_id: @rule.id}`
   (the marker `human_response?` checks on `Message`, §2/§3 note in `message.rb:368`).

5. **Honest assessment (asked for explicitly):** this is a **condition-matcher for a single
   already-happened event, not a journey/sequence engine**. There is no state machine, no
   "wait N days then do Y", no branching on prior actions, no per-contact progress tracking.
   `AutomationRuleListener` re-evaluates all matching rules from scratch on every event with
   no memory of what fired before (aside from the loop-prevention `performed_by_automation?`
   flag). Extending it into a journey engine would mean building an entirely separate
   stateful scheduler next to it (something like the cron-driven `Campaign` one-off path in
   §8, generalized) — you would keep the **condition DSL and its jsonb→SQL translation** (the
   YAML-driven filter dictionary is genuinely reusable and well-factored) but would not reuse
   `AutomationRuleListener`/`ActionService` as the journey runtime. This matches and sharpens
   the structural doc's port-target #3 ranking.

## 8. Campaign execution, traced

Two campaign types share one `Campaign` model (`app/models/campaign.rb`) but have
completely disjoint execution paths, unified only by `campaign_type` being auto-set from
`inbox.inbox_type` at validation time (`ensure_correct_campaign_attributes`, 96-105) — a
user cannot pick "ongoing" for a WhatsApp inbox or vice versa.

### `ongoing` (Website/live-chat only)

1. **Client-side trigger evaluation.** The widget JS fetches active campaigns for the
   website token and evaluates `trigger_rules` **entirely client-side**:
   `filterCampaigns` (`app/javascript/widget/helpers/campaignHelper.js:33-47`) checks
   `isPatternMatchingWithURL` (a `URLPattern` match against `campaign.url`, lines 3-17) and,
   if `trigger_only_during_business_hours`, an `isInBusinessHours` flag computed elsewhere in
   the widget store. **The server never evaluates trigger_rules** — it only stores them and
   trusts whatever `event_info` the widget later POSTs.
2. **Firing.** When the widget decides a campaign should fire, it `POST
   /api/v1/widget/events` with `{name: 'campaign.triggered', event_info: {campaign_id}}`.
   `Api::V1::Widget::EventsController#create`
   (`app/controllers/api/v1/widget/events_controller.rb:5-8`) does something structurally
   notable: **it dispatches whatever event name the client sends**
   (`Rails.configuration.dispatcher.dispatch(permitted_params[:name], ...)`), not just
   campaign events — the widget-events endpoint is a generic client→server event bus, and
   `campaign.triggered` merely happens to be the one name `CampaignListener` subscribes to.
   This is a real trust boundary: the server accepts an arbitrary contact-supplied event name
   and dispatches it into the same `Dispatcher` singleton used for trusted server-originated
   events.
3. **Conversation creation.** `CampaignListener#campaign_triggered`
   (`app/listeners/campaign_listener.rb`) calls
   `Campaigns::CampaignConversationBuilder` (`app/builders/campaigns/
   campaign_conversation_builder.rb`), which — inside a transaction with `@contact_inbox.lock!`
   — **raises if a conversation already exists on that contact_inbox** (line 10, the actual
   double-send guard for this path), then creates the `Conversation` and builds the campaign
   message via `Messages::MessageBuilder`, same builder as automation rules and human replies.

### `one_off` (Twilio SMS / SMS / WhatsApp)

1. **Scheduling.** `TriggerScheduledItemsJob` (cron, every 5 min, §4) queries
   `Campaign.where(campaign_type: :one_off, campaign_status: :active, scheduled_at:
   3.days.ago..Time.current)` and enqueues `Campaigns::TriggerOneoffCampaignJob` per row.
2. **Double-send prevention — the real guard is here, not at dispatch time.**
   `Campaign#trigger!` (`app/models/campaign.rb:39-45`) calls `mark_processing!` (49-54),
   which wraps a `with_lock do ... next if completed? || processing?; processing! end` — a
   **row-level pessimistic lock** (`SELECT ... FOR UPDATE`), specifically because "multiple
   scheduler jobs can pick the same active campaign" (comment on line 50) — i.e. Chatwoot's
   own authors flag this as a real race the 5-minute cron can hit (a campaign still
   `scheduled_at` in the past on two consecutive ticks if the first tick's job hadn't
   flipped status yet). Only after the lock-guarded status flip does `execute_campaign`
   (57-64) run, dispatching to `Twilio::OneoffSmsCampaignService` / `Sms::
   OneoffSmsCampaignService` / `Whatsapp::OneoffCampaignService` by `inbox.inbox_type`.
3. **Fan-out.** `Whatsapp::OneoffCampaignService#perform`
   (`app/services/whatsapp/oneoff_campaign_service.rb:4-8`): `validate_campaign!` (feature
   flag, provider, campaign type/status checks, 12-34), then `process_audience` — resolves
   `audience` (label ids) to `Label` titles, then `campaign.account.contacts.tagged_with
   (audience_labels, any: true)` (63-68), then **synchronously, in a plain `each` loop**
   (line 66) — no per-contact job, no rate limiting visible in this file — calls
   `process_contact` → `send_whatsapp_template_message`, which posts directly to the WhatsApp
   template-send API per contact. A per-contact failure is caught and logged
   (`rescue StandardError`, 88-93) so one bad number doesn't abort the batch, but there is no
   retry and no per-recipient send-status row (delivery status for campaign messages would
   only surface via the generic message-status webhook path in §3, if a `Message` was even
   created — this service **calls `channel.send_template` directly, not through
   `Messages::MessageBuilder`**, so campaign one-off sends may not even produce a `Message`
   row tied to a conversation in the normal way; not fully confirmed, flagged as a gap).
   Finally `campaign.completed!` (line 6) — this is the *only* place completion is set, and
   it fires only after the entire audience loop returns (no partial-progress persistence: a
   worker crash mid-loop leaves the campaign `processing` forever, re-sending the whole
   audience is not automatically prevented on a manual re-trigger since `trigger!` only
   guards `completed?`/`processing?`, and a stuck `processing` campaign is not `active` so
   the cron won't re-pick it, but nothing un-sticks it either).

## 9. Frontend↔backend contract

**REST:** `ApiClient` base class (`app/javascript/dashboard/api/ApiClient.js`) — one
subclass per resource, constructed with `(resource, {apiVersion, enterprise,
accountScoped})`. `baseUrl()` (28-40) composes the URL prefix: `/api/v{1|2}` +
`/enterprise` if flagged + `/accounts/:id` (read from `window.location.pathname`, not from
store state — line 17-26) if `accountScoped`. Every resource client gets `get/show/create/
update/delete` for free (42-60); resource-specific methods are added in each subclass. A
parallel, newer `app/javascript/v3/api/apiClient.js` is a bare `axios.create({baseURL})`
instance used directly by Pinia stores (no class wrapper) — **two REST client patterns
coexist**, Vuex modules use the `ApiClient` class hierarchy, newer Pinia stores
(`stores/calls.js`, `stores/companies.js`) call axios more directly.

**State shape:** Vuex is primary (`app/javascript/dashboard/store/index.js` — 60+ modules
imported, each split into `index.js` (state+mutations)/`actions.js`/`getters.js`, e.g.
`store/modules/conversations/`). Pinia (`defineStore`) is used for newer, narrower features —
confirmed only `calls` and `companies` stores exist under `dashboard/stores/` — this is a
**mid-migration state, not a settled pattern**; a port should pick one (Pinia, given Vuex is
legacy-only in the Vue ecosystem) rather than copy the split.

**ActionCable, precisely (this is where the graph's "5 Channel nodes" claim needed
unpacking):** cbm's `Channel`-labeled nodes (schema: `get_graph_schema` → `Channel` label,
count 5) are **not** 5 Rails `ActionCable::Channel` classes — there is exactly **one**,
`RoomChannel` (`app/channels/room_channel.rb`), plus the connection-boilerplate
`ApplicationCable::Channel`/`Connection`. The graph's 5 "Channel" nodes are inferred **pubsub
stream/event names** from `stream_from`/`broadcast`/`emit` call sites: three
`account_#{...}` ActionCable streams (from `RoomChannel#ensure_stream:29`, and two
WhatsApp-voice-call broadcast call sites in `enterprise/app/services/whatsapp/
{call_service,incoming_call_service}.rb` that broadcast to `"account_#{inbox.account_id}"`/
`"account_#{call.account_id}"` for ringing-agent fan-out) plus two **non-ActionCable**
`event_emitter` entries (`fetch_conversation_stats`, `newToastMessage` — in-page `mitt`
events, unrelated to the network layer, that the extractor's heuristic conflated with cable
channels because both use a `.emit()`-shaped call). **Verified by reading source** (not
just cited from the graph): `RoomChannel#ensure_stream` (`app/channels/room_channel.rb:27-30`)
does `stream_from pubsub_token` **and**, if a logged-in `User` is present, also `stream_from
"account_#{@current_account.id}"` — so each connection actually subscribes to **two**
streams: its own private token (contact or agent identity) and, for agents, a shared
account-wide stream (used for account-broadcast events like `account.cache_invalidated` and
the WhatsApp-calling account-wide ringing broadcast). Every real-time push in §2/§3 targets
the per-token stream via `ActionCable.server.broadcast(pubsub_token, ...)`
(`action_cable_broadcast_job.rb:35-41`), not a Rails `Channel` subclass method — `RoomChannel`
itself only handles `subscribed`/`update_presence` (client→server); all server→client pushes
bypass channel instance methods entirely and broadcast straight to the stream name.

Client-side event map: `ActionCableConnector`
(`app/javascript/dashboard/helper/actionCable.js:28-57`) is a flat `{event_name: handler}`
dispatch table with **29 named events**, each mapped to one or more Vuex `dispatch` calls —
this table is the effective frontend "API contract" for realtime and would need a 1:1
reimplementation for any port that keeps a similar realtime model.

## 10. Reimplementation notes for Open Marketing

1. **HTTP surface** — *Adapt, don't port.* The route taxonomy (agent API / public contact
   API / widget API / webhook ingestion / platform API) is a sound shape to imitate, but
   Chatwoot's own auth story is inconsistent across families (three different schemes:
   devise_token_auth headers, a bespoke `AccessToken`-row lookup for Platform API, and *no*
   auth at all for the public contact API) — design one consistent scheme instead of copying
   this fragmentation.

2. **Inbound message path** — *Port the shape, not the code.* Controller→Job→
   `IncomingMessageService`→`dispatch`→Listener→Broadcast is a clean, reusable pipeline
   pattern. The per-provider dedup mechanics (Redis `SET NX` for message-level dedup, a
   separate mutex for concurrent-webhook races) are a real, hard-won lesson worth copying
   verbatim as a pattern, not just admiring — album/multi-part webhook races are not
   WhatsApp-specific.

3. **Outbound message path** — *Port `Base::SendOnChannelService` as a pattern.* The
   validate→guard→`perform_reply` template method, with loop-prevention baked into
   `invalid_message?`, is the single most reusable piece of plumbing in the whole outbound
   stack. The provider calls themselves (direct `HTTParty` calls with no queue/retry wrapper
   at the HTTP-call layer) are a weak spot, not a model to copy — a marketing sender at
   volume needs a retry/backoff layer Chatwoot doesn't have here.

4. **Async/background layer** — *Adapt.* Sidekiq + `sidekiq-cron` + a fixed queue-priority
   list is standard and fine to imitate structurally. The `prepend_mod_with` enterprise-hook
   pattern (open a module, `prepend` it conditionally) is a clean seam for an OSS-core /
   paid-addon split, worth adopting if Open Marketing ever needs the same split.

5. **Event/listener bus** — *Port the shape, replace the internals.* A synchronous singleton
   dispatcher with typed event constants and listener classes keyed by method-name-equals-
   event-name is simple and debuggable. Given a fresh build, prefer
   `ActiveSupport::Notifications` or an equivalent over hand-rolling a `Dispatcher` — same
   shape, less bespoke code — but the *pattern* (event → N independent listeners, one of
   which is "broadcast to realtime") is exactly right and should be kept.

6. **Data model** — *Port `contacts`/`contact_inboxes`/`custom_attribute_definitions`
   closely; skip the per-channel-table pattern.* The contact/CDP shape is genuinely good.
   The lack of a unified `channels` table (12 separate tables + polymorphic `channel_type`)
   is a real historical-growth wart — a marketing product with heavier channel plans should
   use a single `channels` table with a `provider` discriminator and a `config` jsonb column
   from day one, not Chatwoot's 12-table-and-growing shape.

7. **Automation rules** — *Port the condition DSL + jsonb→SQL translator as a component;
   do not port the engine as a journey system* (confirmed firsthand in §7, not just cited
   from the structural doc: it is a single-event condition matcher with no state, and
   extending it into a journey engine means building a new stateful runtime beside it, not
   inside it).

8. **Campaigns** — *Skip, but take one warning.* Both paths are too thin to port (one is a
   43-line proactive-chat trigger, the other a synchronous audience loop with no
   partial-progress recovery). The one thing worth internalizing: the `one_off` path's
   `with_lock`-guarded status flip is the **only** thing preventing a double-send under
   concurrent cron ticks — a real bug class (Chatwoot's own authors' comment confirms it was
   observed), and Open Marketing's journey/campaign engine needs an equivalent guard
   designed in from the start, not bolted on after the first incident.

9. **Frontend↔backend contract** — *Skip (different stack: Next/Electron vs. Vue).*
   The one transferable idea is the per-identity ActionCable stream (`pubsub_token`) rather
   than a single account-wide firehose — it means every client filters nothing client-side
   and the server decides exactly who receives each event, which scales fine and is worth
   keeping as a design principle regardless of the transport (WebSocket/SSE) chosen.

10. **Overall:** nothing in this behavioral trace changes the structural doc's verdict —
    Chatwoot is a well-built support inbox with no marketing-journey depth. The new
    information here is *how thin* the campaign/automation runtimes are once traced end to
    end (single-event matching, no state, one synchronous audience loop with a fragile
    completion guard), which should remove any temptation to treat `AutomationRule` or
    `Campaign` as a scaffolding to extend rather than a reference to move past.

## What I could not verify

- **Whether `Whatsapp::OneoffCampaignService` creates a `Message`/`Conversation` row per
  send.** It calls `channel.send_template` directly rather than through
  `Messages::MessageBuilder`; I could not find, in the files read, where (or whether) a
  `Message` row gets created for a one-off campaign send. This matters for anyone wanting to
  show campaign-send history in a conversation timeline — flagged as a gap, not confirmed
  either way. Needs `grep`ing `provider_service#send_template`'s Meta-side response handling
  and whatever calls it afterward, and checking `Twilio::OneoffSmsCampaignService`/
  `Sms::OneoffSmsCampaignService` for the same question (not read).
- **`SyncDispatcher`/`AsyncDispatcher` internals** (`app/dispatchers/` — only the top-level
  `Dispatcher` singleton was read; I did not open the two dispatcher implementation files, so
  "synchronous, in-process" for both is inferred from `Dispatcher#dispatch` calling both
  without any queue/thread primitive visible at that call site, not from reading their
  bodies).
- **`FilterService` base class** (`app/services/filters/` — referenced but not opened; the
  claim that automation conditions and saved "custom view" filters share one engine rests on
  the `< FilterService` superclass relationship only, not on reading the shared code).
- **`ActionService` base class** that `AutomationRules::ActionService` extends, and whether
  `MacrosExecutionJob` reuses the same action vocabulary — plausible from naming, not
  confirmed by reading either file.
- **Twilio/SMS/Line/Telegram/TikTok incoming-message-service bodies** were located but not
  opened in full — the divergence table in §2 is built from file existence, class hierarchy
  (`grep`/`search_graph`), and the WhatsApp base-class pattern by analogy, not from reading
  every one of the 11 other channels' service code line by line. Treat the "job-level dedup"
  column entries for those as an inference (no WhatsApp-style Redis mutex found in a
  targeted grep for `Redis::Alfred` outside the whatsapp job), not a confirmed absence.
- **`Mailboxes::*` email-parsing path** — not traced at all beyond confirming the IMAP-poll
  entry point; email is the one channel whose inbound builder chain (MIME parsing,
  threading-by-Message-ID, attachment extraction) is completely unverified here.
- **cbm's `Channel` node inference logic** (why `event_emitter` entries were labeled
  `Channel`) — described from the observed output, not from reading the extractor's source
  (the extractor is cbm's own internals, outside this repo).
- **Enterprise `whatsapp_calls`/voice subsystem** — read only far enough
  (`enterprise/app/services/whatsapp/{call_service,incoming_call_service}.rb` grep hits) to
  source the two account-wide broadcast streams in §9; the WebRTC signaling flow itself is
  unverified.
- **Exact endpoint counts per HTTP family** — explicitly approximate, see the tool-trap note
  at the top of §1. Do not treat any number in the §1 table as exact.

## Handoff

- **Inputs used:** `config/routes.rb` (full, 726 lines), `db/schema.rb` (targeted
  `create_table` blocks for 15 tables), `config/sidekiq.yml`, `config/schedule.yml` (full),
  `app/listeners/*.rb` (all 12, `base_listener.rb` + 3 read in full, others confirmed by
  method-name grep), `app/dispatchers/dispatcher.rb`, `config/initializers/
  event_handlers.rb`, `app/models/message.rb` (message lifecycle section), `app/models/
  campaign.rb`, `app/models/channel/whatsapp.rb`, WhatsApp inbound chain (4 files, full),
  WhatsApp outbound chain (4 files, full), `app/jobs/send_reply_job.rb`,
  `app/jobs/action_cable_broadcast_job.rb`, `app/jobs/campaigns/trigger_oneoff_campaign_job.rb`,
  `app/jobs/trigger_scheduled_items_job.rb` + its two `Internal::Trigger*` core jobs + their
  2 enterprise `prepend_mod_with` overrides, `app/services/automation_rules/{conditions_filter_service,action_service}.rb`
  (full), `app/services/whatsapp/oneoff_campaign_service.rb` (full),
  `app/builders/campaigns/campaign_conversation_builder.rb` (full),
  `app/controllers/api/v1/widget/{events,messages}_controller.rb`,
  `app/controllers/public/api/v1/inboxes_controller.rb` + its messages controller,
  `app/controllers/{platform_controller,public_controller}.rb`, `app/controllers/api/
  base_controller.rb` + `api/v1/accounts/base_controller.rb`, ActionCable chain (5 files:
  `room_channel.rb`, `BaseActionCableConnector.js`, `actionCable.js` (dashboard),
  `ApiClient.js`, `v3/api/apiClient.js`), `app/javascript/dashboard/store/index.js` (module
  list only), `app/javascript/dashboard/stores/calls.js` (partial), `app/javascript/widget/
  helpers/campaignHelper.js` (full). Graph tool use: `get_graph_schema`, one `search_graph`
  (`.*Channel.*`), two `query_graph` Cypher calls (Route-node audit that surfaced the tool
  trap; the 5-Channel-node query, source-verified afterward).
- **Output:** this file, `/Users/la/Programming/Open-Marketing/docs/chatwoot-sitemap.md`.
- **Risks:** the endpoint-count table (§1) is the weakest section — approximate hand counts
  flagged as such. The campaign-message-row question (first item in "could not verify") is
  the most product-relevant open gap: if you plan to reuse any campaign-send code path, chase
  that down first, don't assume message-history parity with the human-reply path.
- **Suggested next assignee:** whoever does the Liquid-drops port (structural doc's #1
  port target) should read `app/services/whatsapp/liquid_template_processor_service.rb` and
  `app/services/whatsapp/template_processor_service.rb` next — both were named in this trace
  (campaign template rendering, §8) but not opened, and they sit directly on top of the
  Liquid drops layer the structural doc flagged as highest port value.
