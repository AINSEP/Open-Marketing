import type { AdAccountPolicy, Consent, GateDecision, MessageChannel, Money, ShareDestination, SubjectPolicy, TimeWindow } from "./types.js";
const allowed: GateDecision = Object.freeze({ allowed: true });
const deny = ({ reason }: {
    reason: Extract<GateDecision, {
        allowed: false;
    }>["reason"];
}): GateDecision => ({ allowed: false, reason });
const integer = ({ value }: {
    value: number;
}): boolean => Number.isSafeInteger(value) && value >= 0;
const validWindow = (window: TimeWindow): boolean => integer({ value: window.start }) && integer({ value: window.end }) && window.start < window.end;
const active = ({ window, now }: {
    window: TimeWindow;
    now: number;
}): boolean => window.start <= now && now < window.end;
/** Resolve explicit grants; a matching withdrawal remains effective from its start.
 * A new grant cannot silently reverse withdrawal; snapshot resolution must remove superseded records.
 * @complexity O(n) time and O(1) space.
 */
function consentDecision({ consents, scope, target, purpose, now }: {
    consents: readonly Consent[];
    scope: Consent["scope"];
    target: string;
    purpose: string;
    now: number;
}): GateDecision {
    if (!integer({ value: now }) || !target.trim() || !purpose.trim())
        return deny({ reason: "invalid_input" });
    let granted = false;
    for (const consent of consents) {
        const inspection = inspectConsent({ consent, scope, target, purpose, now });
        if (inspection.denial) return inspection.denial;
        if (inspection.granted) granted = true;
    }
    return granted ? allowed : deny({ reason: "consent_missing" });
}
/** Classify one record in original order; withdrawal still wins immediately. */
function inspectConsent(required: { consent: Consent; scope: Consent["scope"]; target: string; purpose: string; now: number }): { denial?: GateDecision; granted: boolean } {
 const { consent, scope, target, purpose, now } = required;
 if (!validWindow(consent) || !["granted", "withdrawn"].includes(consent.status)) return { denial: deny({ reason: "invalid_input" }), granted: false };
 if (consent.scope !== scope || consent.target !== target || consent.purpose !== purpose) return { granted: false };
 if (consent.status === "withdrawn" && consent.start <= now) return { denial: deny({ reason: "consent_withdrawn" }), granted: false };
 return { granted: consent.status === "granted" && active({ window: consent, now }) };
}
/** Same ordered suppression scan; invalid records deny before subsequent records. */
function suppressionDecision(required: { subject: SubjectPolicy; channel: MessageChannel; now: number }): GateDecision {
 for (const suppression of required.subject.suppressions) {
  if (!validWindow(suppression)) return deny({ reason: "invalid_input" });
  if (suppression.channel === required.channel.id && active({ window: suppression, now: required.now })) return deny({ reason: "suppressed" });
 }
 return allowed;
}
/** Decide messaging eligibility from a caller-owned immutable policy snapshot.
 * No I/O or reservation occurs; refresh and reserve frequency capacity atomically at dispatch.
 * Invalid numeric policy denies. The caller reads injected time before invoking the gate.
 * @complexity O(consents + suppressions) time, O(1) space.
 */
export function sendability({ subject, channel, purpose, now }: {
    subject: SubjectPolicy;
    channel: MessageChannel;
    purpose: string;
    now: number;
}, optional?: Record<string, never>): GateDecision {
    if (!["marketing", "transactional"].includes(channel.intent))
        return deny({ reason: "invalid_input" });
    const consent = consentDecision({ consents: subject.consents, scope: "channel", target: channel.id, purpose: purpose, now: now });
    if (!consent.allowed)
        return consent;
    if (subject.holdout && channel.intent === "marketing")
        return deny({ reason: "holdout" });
    const suppression = suppressionDecision({ subject, channel, now });
    if (!suppression.allowed) return suppression;
    const cap = subject.frequencyCap;
    if (cap && (!integer({ value: cap.count }) || !integer({ value: cap.limit })))
        return deny({ reason: "invalid_input" });
    if (cap && cap.count >= cap.limit)
        return deny({ reason: "frequency_cap" });
    return allowed;
}
/** Decide identifier sharing eligibility; suppression is messaging-only.
 * Measurement still requires explicit destination/purpose consent. No identifier export occurs.
 * The caller reads injected time. @complexity O(consents) time, O(1) space.
 */
export function shareability({ subject, destination, purpose, now }: {
    subject: SubjectPolicy;
    destination: ShareDestination;
    purpose: string;
    now: number;
}): GateDecision {
    if (!["audience", "measurement"].includes(destination.intent))
        return deny({ reason: "invalid_input" });
    const consent = consentDecision({ consents: subject.consents, scope: "destination", target: destination.id, purpose: purpose, now: now });
    if (!consent.allowed)
        return consent;
    return subject.holdout && destination.intent === "audience" ? deny({ reason: "holdout" }) : allowed;
}
/** Decide eligibility within one supplied exact-operation policy snapshot in exact integer minor units.
 * This pure check is NOT an atomic reservation and does not authorize a platform write.
 * The outbox must recheck halt/revocation and reserve under a database transaction.
 * The caller reads injected time. @complexity O(1) time/space.
 */
export function spendability({ account, amount, window, now }: {
    account: AdAccountPolicy;
    amount: Money;
    window: TimeWindow;
    now: number;
}, optional?: Record<string, never>): GateDecision {
    if (!integer({ value: now }) || !integer({ value: amount.minorUnits }) || amount.minorUnits === 0 || !/^[A-Z]{3}$/.test(amount.currency) || !validWindow(window))
        return deny({ reason: "invalid_input" });
    if (account.halted)
        return deny({ reason: "account_halted" });
    const authorization = account.authorization;
    if (!authorization)
        return deny({ reason: "authorization_missing" });
    if (authorization.revoked)
        return deny({ reason: "authorization_revoked" });
    if (!validWindow(authorization) || ![authorization.capMinorUnits, authorization.committedMinorUnits, authorization.reservedMinorUnits].every(value => integer({ value })))
        return deny({ reason: "invalid_input" });
    if (authorization.currency !== amount.currency)
        return deny({ reason: "currency_mismatch" });
    if (!active({ window: window, now: now }) || !active({ window: authorization, now: now }) || window.start < authorization.start || window.end > authorization.end)
        return deny({ reason: "outside_window" });
    // Subtraction avoids overflow from adding individually safe integer counters.
    const remaining = authorization.capMinorUnits - authorization.committedMinorUnits - authorization.reservedMinorUnits;
    return amount.minorUnits <= remaining ? allowed : deny({ reason: "budget_exceeded" });
}
