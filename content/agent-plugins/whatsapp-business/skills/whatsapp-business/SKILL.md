---
name: whatsapp-business
description: Inspect WhatsApp assets and send one approved template through the owner-only OM message path when enabled.
---

Use get_account_status, list_senders and list_templates through OM. Page at most 100 rows with returned cursors; missing asset facts remain unknown. Send one approved template via `om_message_send` (`om tools call om_message_send --input-file message.json`), using `message: { template: { name, language, bodyParameters } }`. The exact card shows recipient, template + variables and maximum USD cost; only Allow/Cancel applies. Never bypass the host with vendor HTTP/MCP.

Production remains read_only and current primary numeric rates are unavailable: sending refuses before reservation. When enabled with verified rates, the plugin reads USD account currency and exact template approval/category before authority. Quote = Meta list-rate upper bound, ceiling-rounded to USD cents; no discount or free window is assumed. Meta revises rates quarterly; the local evidence date is auditable but does not automatically expire.

Free-form is refused because OM cannot prove the 24-hour service window. No broadcasts, scheduling, media/button/header/named parameters or template creation. Never disguise a MARKETING template as transactional intent: host-to-plugin intent enforcement is still deferred.

Reuse a server-held Meta credential with verified WABA/phone ownership. Sending needs whatsapp_business_messaging plus management permission. Never put credentials in chat/tool arguments. Host policy rechecks WhatsApp opt-in, suppression/erasure and current authority under the subject lane; unknown pricing refuses. Accepted is provider submission, not handset delivery; unknown requires reconciliation without resubmission. Signed webhook STOP is authoritative; START/HELP never restores consent. GET challenge/subscription and phone-less identity alias capture remain deferred.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval; every send is rechecked against OM's server consent, suppression and quiet-hours records at dispatch. This skill never grants permission to message anyone, and chat statements are not consent evidence.

### Opt-in and consent

- WhatsApp requires a recipient-supplied number or username plus opt-in.
  The business chooses its opt-in method; honour block and stop requests
  received on WhatsApp or elsewhere.
- Recommend purpose-specific opt-in per message category, naming the sender,
  what will arrive and how to opt out of that category.
- OM's server consent record is authoritative. Never record, assume or upgrade
  consent from chat or an uploaded list; START/HELP cannot restore consent.

### Templates and the service window

- Review the approved template's marketing, utility or authentication category
  against its actual purpose; check current WhatsApp docs for categorisation.
- WhatsApp's policy describes a 24-hour customer service window opened and
  reset by each user message: non-template replies are allowed within it;
  outside it, only approved templates may be sent.
- That window is platform context only. OM exposes no freeform or reply send,
  and uses only approved-template sends; it never widens what OM will send.
  A template's presence in a list does not replace the server checks above.

### Message content

- Draft for the purpose the recipient expected and the template being reviewed.
  Make the business identity and reason for contact easy to recognise.
- Keep variable text within the approved template's meaning and OM's supported
  body parameters. Do not disguise a promotion as a service update or promise
  unsupported media, buttons, headers or template creation.

### Frequency and cost

- Use email-lifecycle for frequency, suppression and cross-channel permission
  method. Review broadcast overlap and recipient relevance before proposing
  another message; avoid a universal broadcast cadence.
- Check current WhatsApp docs for pricing and availability. Do not infer that
  an open service window or an approved template gives OM free-send authority;
  unknown pricing and read-only production mode still mean unavailable.

### Measurement pitfalls

- Distinguish a submission receipt, delivery observation, recipient response
  and downstream business outcome; do not label acceptance as a completed sale.
- Keep stop requests and missing delivery feedback visible when reviewing a
  broadcast. A larger reachable list does not establish consent or relevance.
- Review only evidence the owner supplies or OM can read; leave unverified
  outcomes pending rather than proposing retries of uncertain submissions.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
