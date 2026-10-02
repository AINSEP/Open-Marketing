# Architect reviews — Open Marketing

Raw source material behind `../open-marketing-build-plan.md`. Five models answered the
same brief independently, in separate processes, with no shared context beyond the brief.

Read the plan first; these are the underlying answers, kept because the synthesis
necessarily compressed them.

## The final round

- `00-brief-final.md` — the brief all five answered (v3)
- `opus-5.md` — longest and most source-grounded; corrected its own draft twice after
  reading Jini's code. Origin of the three-poller split, `shareability()`, the outbound
  erasure cascade, and the conversion-feed decay prediction.
- `fable-5.1.md` — verified the four contested package questions against source; origin
  of "every gate is an envelope, `ApprovalKind` is a closed enum" and the
  defer-the-module-reserve-the-field resolution for commerce and holdouts.
- `gpt-6-astra.md` — most exhaustive module inventory (40+). Sole source for the commerce
  context and experimentation modules, and for the warning against building four ad
  adapters at once.
- `gemini-3.1-pro.md` — sharpest statement of the one-product argument via the
  `fbclid`/`gclid` → `subject_identifier` join.
- `gemini-3.8-flash.md` — longest single answer (3,534 words); broad module coverage.

## Provenance notes

Two conclusions in the plan rest on a model **correcting itself** after reading source
rather than package docs — both about `@jini-ai/integrations/media-providers` having a
real submit-then-poll async tier. That is why the plan marks source-verified claims
distinctly: the README-level reading was wrong in both cases, in the direction of more
work rather than less.

## superseded/

Earlier rounds, kept for provenance only — **do not use for decisions.**

- `brief-v1-messaging-only.md` — scoped to lifecycle/email only; missed paid media,
  creative, MCP and analytics entirely.
- `brief-v2-no-paid-mechanics.md` — added the four domains but still missed the
  conversion-tracking loop, landing pages/forms, creative fatigue, and attribution reality.
- `round1-*`, `round2-*` — answers to those briefs.
- Files marked `BROKEN-PIPE` are invalid through operator error, not model failure: the
  brief was piped to the CLI on stdin and did not reach the model, so both answers
  describe unrelated systems. Fixed by passing the brief inline. Noted so nobody
  mistakes them for evidence about model quality.
