---
name: meta-ads
description: Explain Meta campaign evidence and publish organic Instagram images, carousels and Reels through server Open Marketing tools.
---

Use the server's generic Open Marketing campaign, measurement, connection and activity tools. This plugin remains disabled and unadmitted until the server owner verifies its capabilities. Installation does not grant spend, mutation or conversion authority.

Create paused drafts, then require complete configured-status readback for the campaign, ad sets and ads. An acknowledgement alone does not prove PAUSED. Present activation as an exact reviewed operation; every entity activation, budget change or cap mutation needs its own exact spend approval. Ad spend offers no Always allow, chat-wide waiver, reusable budget envelope or automatic reallocation.

Daily budgets are averages. A campaign spending cap is cumulative. Neither establishes a hard daily ceiling. If the required platform control or its readback is unsupported or unverified, explain that the operation is unavailable and show the server's connect or evidence action.

Halt locally first. The server may then use a verified typed backend pause/stop mapping for existing entities. A halt exception cannot activate delivery, change budgets or invoke arbitrary updater fields.

Conversion delivery is a typed server worker job under current measurement consent; it is not an agent tool. Do not send identifiers through chat tools or request vendor credentials. Production ad mutations and conversions require the always-on server; desktop local sandbox mode does not authorize production writes.

On timeout, interruption or an ambiguous acknowledgement, show unknown outcome and use read-only reconciliation. Do not repeat creation or activation because an acknowledgement was lost. Reconnect through the generic server connection flow; neither connection nor refresh restores expired exact approval.

Reports distinguish platform spend from OM-attributed verified conversions. Preserve account, currency, timezone, period and attribution window. Do not add together platform-attributed totals or divide mixed-currency spend. Late/restated observations append lineage in the server.

For organic Instagram, use `instagram_accounts` to discover professional accounts linked to Facebook Pages. Ask for the intended account when ambiguous. The server handles token/scopes through Integrations; never request a token in chat. The four definitions are exported by the plugin for the assistant's ONE server catalog; they become available after composition/catalog integration and admission, not through a separate MCP server.

Use ONE `instagram_publish_post` call for the whole post. Arguments have `kind: image|carousel|reel|resume`, `igUserId` and `caption`. Images add `imageUrl`, Reels add `videoUrl`, carousels add ordered `items` (2–10 imageUrl/videoUrl objects). JPEG is the supported image format; Reel is not a carousel child. Keep hashtags in the unchanged caption (<=2,200 characters, <=30 hashtags, <=20 mentions). The generic exact card reviews the account, caption and media URLs; organic publishing is an ordinary write, not ad spend. Do not request per-container/per-child approvals.

Any public HTTPS media URL is allowed. For an OM asset, obtain the server's public media URL; a local file, localhost or private/local URL cannot work. Explain: “Instagram needs a publicly reachable media URL; this OM asset is only available locally.” Do not invent a hosting/upload endpoint or send raw local paths. Server public-media hosting is a pending integration. Never add scheduling fields: native scheduling is unsupported in this flow.

`instagram_publish_post` creates children/parent or a single/Reel container, polls within five minutes, checks returned publishing quota and publishes only a ready container. `published` is success; the media ID can be absent after read-only reconciliation. `processing` names the parent container: an explicit follow-up `resume` with that ID uses a new reviewed operation, never creates again, and cannot alter the existing caption/media. If `unknown`, use only `instagram_post_status` (containerId + igUserId) and report uncertainty; do not automatically retry/recreate or issue a new operation ID to bypass the outbox. A pending child/unknown creation returns no resumable parent ID; do not publish a child directly. ERROR/EXPIRED/quota exhaustion requires an explicit useful explanation, never a blind retry.

`instagram_post_status` reads status and returned quota; `instagram_media_insights` reads reach, views and total interactions for a mediaId. Preserve unavailable metrics as absent rather than zero. Do not request deprecated impressions. Account discovery is bounded to the first 100 Pages and signals `hasMore`; continuation is deferred. See the plugin README and `evidence/primary-sources.json` for official Graph references, configured version, permissions and known verification limits.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Review whether the campaign objective, ad-set outcome and selected event
  describe the same business result. A traffic plan does not establish a sales signal.
- Ask what each ad set contributes before recommending consolidation;
  account history and usable conversion evidence may differ between campaigns.

### Targeting

- Review intended audiences and possible overlap between ad sets as questions
  for account evidence, without assuming overlap proves wasted spend.
- Keep audience planning separate from fields available in the OM catalog;
  check current Meta docs for targeting options and account eligibility.

### Creative

- Review how the creative renders in each selected placement in Meta's own
  previews; OM does not render vendor previews.
- Keep the offer recognisable from the ad to its destination; check current
  Meta docs for placement formats and media specifications.

### Budget/bidding

- Identify which campaign or ad-set setting owns the proposed allocation
  before assessing whether the budget can support the intended outcome.
- Check current Meta docs for bidding options. Ground budget advice in this
  account's outcome evidence; do not invent a universal threshold or bid rule.

### Measurement pitfalls

- Assess account delivery history, pixel/event-source history and conversion
  history separately. A new account does not establish a new event source,
  and valid raw events do not establish usable conversion history.
- Missing history leaves maturity unknown; it does not diagnose poor creative.
  Explain platform-attributed versus OM-attributed outcomes before judging sales.

Use om-playbook's strategy-and-brief for briefs, ad-copy-variants for copy field limits, creative-test-plan and creative-fatigue-review for creative methods, analytics-attribution-basics for attribution, and landing-page-cro for destination/message consistency.

[Provenance](PROVENANCE.md)
