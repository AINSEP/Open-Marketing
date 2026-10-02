# Spine policy gates

Framework-independent eligibility decisions over trusted, readonly snapshots.
Every gate receives an injected `Clock`; times are nonnegative UTC epoch
milliseconds and windows include the start but exclude the end.

- `sendability(subject, channel, purpose, clock)` requires an explicit matching
  channel grant, applies active channel suppression and the supplied frequency
  counter, and excludes global holdouts from marketing messages.
- `shareability(subject, destination, purpose, clock)` requires an explicit
  destination grant. Messaging suppression does not apply. Holdouts cannot enter
  audience exports; measurement has its own explicit intent and still needs consent.
- `spendability(account, amount, window, clock)` evaluates one selected budget
  authorization. Requested positive integer minor units must fit after committed
  and reserved totals, with exact currency and a contained active window.

A matching withdrawal effective at or before the clock denies even if another
grant overlaps. Withdrawal remains effective after its record's end time;
upstream policy resolution must explicitly remove superseded withdrawals when
processing a subsequent authorized grant. Missing or expired grants deny.
Malformed numeric policy denies with `invalid_input`; failures thrown by the
clock propagate. These are application policy rules, not legal advice or an
assertion that consent is the only possible legal basis.

The snapshot types are not runtime JSON validators. An adapter must validate
external data, resolve identity and policy revisions, and supply fresh snapshots.
Readonly types do not freeze caller-owned objects at runtime.

These functions perform no I/O, export, send, counter update, or reservation.
Two callers can independently pass against the same budget snapshot. A future
transactional adapter must recheck eligibility and atomically reserve capacity,
and its outbox must recheck account halt and revocation before platform writes.
No runtime wiring is included in this independent module.
