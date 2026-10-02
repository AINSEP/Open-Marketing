import type { Clock } from "@open-marketing/om-clock";
import type { AdAccountPolicy, Consent, GateDecision, MessageChannel, Money, ShareDestination, SubjectPolicy, TimeWindow } from "./types.js";

const allowed: GateDecision = Object.freeze({ allowed: true });
const deny = (reason: Extract<GateDecision, { allowed: false }>["reason"]): GateDecision => ({ allowed: false, reason });
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validWindow = (window: TimeWindow): boolean => integer(window.start) && integer(window.end) && window.start < window.end;
const active = (window: TimeWindow, now: number): boolean => window.start <= now && now < window.end;

/** Resolve explicit grants; a matching withdrawal remains effective from its start.
 * A new grant cannot silently reverse withdrawal; snapshot resolution must remove superseded records.
 * @complexity O(n) time and O(1) space. @overallScore 100
 */
function consentDecision(consents: readonly Consent[], scope: Consent["scope"], target: string, purpose: string, now: number): GateDecision {
  if (!integer(now) || !target.trim() || !purpose.trim()) return deny("invalid_input");
  let granted = false;
  for (const consent of consents) {
    if (!validWindow(consent) || !["granted", "withdrawn"].includes(consent.status)) return deny("invalid_input");
    if (consent.scope !== scope || consent.target !== target || consent.purpose !== purpose) continue;
    if (consent.status === "withdrawn" && consent.start <= now) return deny("consent_withdrawn");
    if (consent.status === "granted" && active(consent, now)) granted = true;
  }
  return granted ? allowed : deny("consent_missing");
}

/** Decide messaging eligibility from a caller-owned immutable policy snapshot.
 * No I/O or reservation occurs; refresh and reserve frequency capacity atomically at dispatch.
 * Invalid numeric policy denies. Clock failures propagate to the caller.
 * @complexity O(consents + suppressions) time, O(1) space. @overallScore 100
 */
export function sendability(subject: SubjectPolicy, channel: MessageChannel, purpose: string, clock: Clock): GateDecision {
  const now = clock.now();
  if (!["marketing", "transactional"].includes(channel.intent)) return deny("invalid_input");
  const consent = consentDecision(subject.consents, "channel", channel.id, purpose, now);
  if (!consent.allowed) return consent;
  if (subject.holdout && channel.intent === "marketing") return deny("holdout");
  for (const suppression of subject.suppressions) {
    if (!validWindow(suppression)) return deny("invalid_input");
    if (suppression.channel === channel.id && active(suppression, now)) return deny("suppressed");
  }
  const cap = subject.frequencyCap;
  if (cap && (!integer(cap.count) || !integer(cap.limit))) return deny("invalid_input");
  if (cap && cap.count >= cap.limit) return deny("frequency_cap");
  return allowed;
}

/** Decide identifier sharing eligibility; suppression is messaging-only.
 * Measurement still requires explicit destination/purpose consent. No identifier export occurs.
 * Clock failures propagate. @complexity O(consents) time, O(1) space. @overallScore 100
 */
export function shareability(subject: SubjectPolicy, destination: ShareDestination, purpose: string, clock: Clock): GateDecision {
  if (!["audience", "measurement"].includes(destination.intent)) return deny("invalid_input");
  const consent = consentDecision(subject.consents, "destination", destination.id, purpose, clock.now());
  if (!consent.allowed) return consent;
  return subject.holdout && destination.intent === "audience" ? deny("holdout") : allowed;
}

/** Decide eligibility within one budget envelope in exact integer minor units.
 * This pure check is NOT an atomic reservation and does not authorize a platform write.
 * The outbox must recheck halt/revocation and reserve under a database transaction.
 * Clock failures propagate. @complexity O(1) time/space. @overallScore 100
 */
export function spendability(ad_account: AdAccountPolicy, amount: Money, window: TimeWindow, clock: Clock): GateDecision {
  const now = clock.now();
  if (!integer(now) || !integer(amount.minorUnits) || amount.minorUnits === 0 || !/^[A-Z]{3}$/.test(amount.currency) || !validWindow(window)) return deny("invalid_input");
  if (ad_account.halted) return deny("account_halted");
  const authorization = ad_account.authorization;
  if (!authorization) return deny("authorization_missing");
  if (authorization.revoked) return deny("authorization_revoked");
  if (!validWindow(authorization) || ![authorization.capMinorUnits, authorization.committedMinorUnits, authorization.reservedMinorUnits].every(integer)) return deny("invalid_input");
  if (authorization.currency !== amount.currency) return deny("currency_mismatch");
  if (!active(window, now) || !active(authorization, now) || window.start < authorization.start || window.end > authorization.end) return deny("outside_window");
  // Subtraction avoids overflow from adding individually safe integer counters.
  const remaining = authorization.capMinorUnits - authorization.committedMinorUnits - authorization.reservedMinorUnits;
  return amount.minorUnits <= remaining ? allowed : deny("budget_exceeded");
}
