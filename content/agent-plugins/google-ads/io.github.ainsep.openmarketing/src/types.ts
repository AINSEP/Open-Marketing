import type { CallContext, ClockPort, EffectEnvelope, Outcome, Scope } from "@open-marketing/contracts";

/** Server-resolved account binding. Never accepted in agent tool arguments. */
export interface AccountBinding {
  scope: Scope; connectionId: string; customerId: string; currency: string; timezone: string;
  mode: "sandbox" | "read_only" | "production"; pluginDigest: string; schemaFingerprint: string;
}
/** Search-only RSA plan. Child serving state is controlled alongside the campaign. */
export interface SearchPlan {
  name: string; currency: string; averageDailyBudgetMicros: string; cpcBidMicros: string;
  startsAt: number; endsAt: number; geoTargetIds: string[];
  keywords: { text: string; matchType: "EXACT" | "PHRASE" }[];
  headlines: string[]; descriptions: string[]; finalUrl: string;
  euPoliticalAdvertising: "CONTAINS_EU_POLITICAL_ADVERTISING" | "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";
}
/** Narrow operations: no user-supplied GAQL, URL, mutation operation or update mask. */
export type ToolArguments =
  | { operationId: string; plan: SearchPlan }
  | { operationId: string; campaignId: string }
  | { operationId: string; campaignId: string; averageDailyBudgetMicros: string }
  | { operationId: string; startDate: string; endDate: string }
  | { operationId: string };
export type ToolName = "list_accounts" | "read_campaign" | "read_budget" | "report" | "create_paused" | "activate" | "set_budget" | "pause" | "reconcile";
export interface ToolCall { name: ToolName; arguments: ToolArguments }
/** All remote hierarchy evidence is parsed before adoption. */
export interface Hierarchy {
  customerId: string; campaignId: string; budgetId: string; name: string;
  currency: string; timezone: string; testAccount: boolean;
  status: "PAUSED" | "ENABLED" | "REMOVED"; channel: "SEARCH";
  searchPartners: boolean; displayNetwork: boolean;
  averageDailyBudgetMicros: string; sharedBudget: boolean; period: "DAILY";
  startsAt: number; endsAt: number; childIds: string[];
  childStatuses: ("PAUSED" | "ENABLED" | "REMOVED")[]; observedAt: number; planDigest: string;
}
/** Complete same-day history comes from server custody, never from tool arguments. */
export interface BillingEvidence {
  evidenceId: string; observedAt: number; localDate: string; historyComplete: boolean;
  highestBudgetTodayMicros: string; monthToDateBilledMicros: string;
  remainingDaysIncludingToday: number; productionVerified: boolean;
}
export interface Receipt {
  operationId: string; status: "acknowledged" | "unknown";
  campaignId?: string; hierarchy?: Hierarchy; requestId?: string;
}
/** ONE server jobs outbox stores these mappings. Claim is atomic; outcomes append.
 * Existing claims never authorize another send, including after timeout/restart. */
export interface OperationRecord {
  key: string; accountKey: string; operationId: string; digest: string; name: ToolName;
  arguments: ToolArguments; receipt: Receipt; marker: string;
}
export interface OperationJournalPort {
  claim(required: { record: OperationRecord }): Promise<Outcome<{ acquired: boolean; record: OperationRecord }>>;
  append(required: { record: OperationRecord }): Promise<Outcome<void>>;
  get(required: { key: string }): Promise<Outcome<OperationRecord | null>>;
  findCampaign(required: { binding: AccountBinding; campaignId: string }): Promise<Outcome<OperationRecord | null>>;
}
/** Internal provider request. Public tools cannot select method, path or body. */
export interface VendorRequest {
  method: "search" | "mutate" | "ingest" | "request_status"; body: Record<string, unknown>;
  /** Required for Data Manager; supplied only by the typed backend. */
  cloudProjectId?: string;
  context: CallContext; operationId: string;
}
export interface GoogleTransportPort {
  request(required: VendorRequest): Promise<Outcome<unknown>>;
}
/** Host owns final authority, audit, halt serialization, production mode and credentials.
 * dispatch MUST invoke execute under current authority with no await gap after its
 * last check. Every HTTP mutation, including validateOnly, crosses this seam.
 * execute is a documented foreign callback ABI. */
export interface HostAuthorityPort {
  dispatch<T>(required: {
    context: CallContext; binding: AccountBinding; effect: EffectEnvelope;
    execute: () => Promise<Outcome<T>>;
  }): Promise<Outcome<T>>;
  billing(required: { context: CallContext; binding: AccountBinding; hierarchy: Hierarchy }): Promise<Outcome<BillingEvidence>>;
}
export interface GooglePluginDependencies {
  binding: AccountBinding; transport: GoogleTransportPort; journal: OperationJournalPort;
  authority: HostAuthorityPort; clock: ClockPort;
}
/** Injectable JSON HTTP seam. Credential, authorization and bounded transport belong here. */
export interface HttpRequest {
  url: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number;
  context: CallContext; operationId: string;
}
export interface HttpPort {
  post(required: HttpRequest & { body: string }): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>>;
  /** Optional for Search-only hosts; Data Manager diagnostics require GET. */
  get?(required: HttpRequest): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>>;
}
export interface CredentialPort {
  /** Host resolves per-advertiser OAuth by binding, verifies granted scope and the
   * owning OAuth Cloud project, and keeps refresh tokens encrypted outside the agent. */
  access(required: { binding: AccountBinding; requiredScope?: string; cloudProjectId?: string }): Promise<Outcome<{ accessToken: string; loginCustomerId?: string; scopes?: string[]; cloudProjectId?: string }>>;
}
