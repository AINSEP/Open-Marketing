/** All times are UTC epoch milliseconds; windows include start and exclude end. */
export interface TimeWindow { readonly start: number; readonly end: number }
export interface Consent extends TimeWindow {
  readonly purpose: string;
  readonly scope: "channel" | "destination";
  readonly target: string;
  readonly status: "granted" | "withdrawn";
}
export interface Suppression extends TimeWindow { readonly channel: string }
export interface FrequencyCap { readonly count: number; readonly limit: number }
/** Trusted typed snapshot, resolved from canonical identity and refreshed before dispatch.
 * Future adapters must validate untrusted JSON before constructing this value; gates are
 * not general-purpose runtime schema parsers. readonly prevents mutation through this API.
 */
export interface SubjectPolicy {
  readonly consents: readonly Consent[];
  readonly suppressions: readonly Suppression[];
  readonly holdout: boolean;
  readonly frequencyCap?: FrequencyCap;
}
/** Intent is explicit so measurement cannot accidentally become audience activation. */
export interface ShareDestination { readonly id: string; readonly intent: "audience" | "measurement" }
export interface MessageChannel { readonly id: string; readonly intent: "marketing" | "transactional" }
export interface Money { readonly minorUnits: number; readonly currency: string }
export interface BudgetAuthorization extends TimeWindow {
  readonly currency: string;
  readonly capMinorUnits: number;
  readonly committedMinorUnits: number;
  readonly reservedMinorUnits: number;
  readonly revoked: boolean;
}
/** Authorization represents one selected envelope; allowances are never summed. */
export interface AdAccountPolicy { readonly halted: boolean; readonly authorization: BudgetAuthorization | null }
export type DenialReason = "invalid_input" | "consent_missing" | "consent_withdrawn" | "suppressed" | "holdout" | "frequency_cap" | "account_halted" | "authorization_missing" | "authorization_revoked" | "outside_window" | "currency_mismatch" | "budget_exceeded";
export type GateDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };
