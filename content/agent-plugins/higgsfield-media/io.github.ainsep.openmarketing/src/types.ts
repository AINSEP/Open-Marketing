import type { AppError, CallContext, CallOptions, ClockPort, GenerationCostQuote, IdPort, Money, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { OperationRuntimeDeps, PollingVendorAdapter, RequestSigner, SubmitOutcome } from "@jini-ai/integrations/media-providers";

/** Render context derived from Jini's PUBLIC adapter ABI; no unexported/deep type import. */
export type HiggsfieldRenderContext = Parameters<PollingVendorAdapter["buildSubmitRequest"]>[0]["ctx"];
/** Real byte result derived from Jini's PUBLIC outcome contract. */
export type HiggsfieldRenderResult = Extract<SubmitOutcome, { kind: "complete" }>["result"];

/** One reviewed image intent. Other surfaces/models need a separately admitted binding. */
export type ImageIntent = {
  readonly operationId: string;
  readonly argumentsDigest: string;
  readonly configurationDigest: string;
  readonly model: string;
  readonly prompt: string;
  readonly seed: number | null;
  readonly parameters: { readonly count?: number; readonly aspect_ratio?: string };
};

/** Host-authored admission snapshot, refreshed before each call by federation. Not a package grant. */
export type VerifiedBinding = {
  readonly pluginId: "higgsfield-media";
  readonly pluginDigest: string;
  readonly configurationDigest: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly scope: CallContext["scope"];
  readonly generationSchemaFingerprint: string;
  readonly statusSchemaFingerprint: string;
  readonly evidenceId: string;
  readonly expiresAt: number;
};

/** Reviewed per-image money bound, or credit conversion. Source/account/configuration are pinned.
 * Credit conversions use a rational minor-unit rate and round up, never floating-point cents.
 */
export type PricingEvidence = {
  readonly evidenceId: string;
  readonly source: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly pluginDigest: string;
  readonly configurationDigest: string;
  readonly generationSchemaFingerprint: string;
  readonly accountId: string;
  readonly model: string;
  readonly argumentsDigest: string;
  readonly unitUpperBound: Money;
  readonly creditRate: { readonly minorUnits: number; readonly creditUnits: number } | null;
};

/** Explicit image reference; the server media port fetches/sniffs it with SSRF and byte guards. */
export type ImportReference = {
  readonly provider: "higgsfield";
  readonly providerJobId: string;
  readonly operationId: string;
  readonly sourceUrl: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/avif";
};

/** Append-only identity: repeating an observation is a no-op; changed amount is a conflict.
 * Missing monetary evidence yields no amount observation, never an inferred zero/refund.
 */
export type ChargeObservation = {
  readonly observationId: string;
  readonly operationId: string;
  readonly providerJobId: string;
  readonly kind: "estimated" | "actual";
  readonly amount: Money;
  readonly pricingEvidenceId: string;
  readonly quoteId: string;
  readonly providerChargeEvidenceId: string | null;
};

/** Structural adapter for FederationHost.invoke; credentials are absent from this port. */
export interface HiggsfieldFederationPort {
  invoke(required: { context: CallContext; call: {
    operationId: string; connectionId: string; toolName: string;
    arguments: Readonly<Record<string, unknown>>; argumentsDigest: string;
    pluginDigest: string; schemaFingerprint: string;
  } }, optional?: CallOptions): Promise<Outcome<{ operationId: string; status: "succeeded" | "failed" | "unknown"; content: readonly unknown[] }>>;
}

/** Server adapters must deduplicate append identities and preserve the import source reference. */
export interface HiggsfieldObservationPort {
  append(required: { context: CallContext; observation: ChargeObservation }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** Guarded media-library adapter. Returns real bytes, validates/sniffs MIME, rejects clipping.
 * It must honor timeout/signal and cap buffers before allocation; no vendor OAuth headers reach CDN.
 */
export interface HiggsfieldMediaPort {
  read(required: { context: CallContext; reference: ImportReference; maxBytes: number; timeoutMs: number }, optional?: CallOptions): Promise<Outcome<HiggsfieldRenderResult>>;
}

/** Reuse the host's canonical federated argument digest rather than invent another JSON encoding. */
export interface HiggsfieldDigestPort {
  digest(required: { arguments: Readonly<Record<string, unknown>> }): Outcome<string>;
}

/** Verifies the provider handle against the server's scoped durable operation, including recovery. */
export interface HiggsfieldJobOwnershipPort {
  verify(required: { context: CallContext; operationId: string; providerJobId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}

/** Host timer/abort boundary must bound the entire callback, including slow admission/OAuth.
 * After timeout, host fencing must prevent a delayed callback from starting egress.
 */
export interface HiggsfieldDeadlinePort {
  run<T>(required: { timeoutMs: number; execute: (required: { signal: AbortSignal }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>>;
}

/** Injected server-only dependencies; construction never connects, submits, or starts workers. */
export type HiggsfieldDependencies = {
  readonly binding: VerifiedBinding;
  readonly intent: ImageIntent;
  readonly context: CallContext;
  readonly quote: GenerationCostQuote;
  readonly pricing: PricingEvidence | null;
  readonly federation: HiggsfieldFederationPort;
  readonly digest: HiggsfieldDigestPort;
  readonly jobs: HiggsfieldJobOwnershipPort;
  readonly observations: HiggsfieldObservationPort;
  readonly media: HiggsfieldMediaPort;
  readonly deadlines: HiggsfieldDeadlinePort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly observer: ObserverPort;
};

/** Public Jini adapter plus in-process federation bridge; host injects its scoped durable store.
 * awaitHandoff waits for the COMPLETE bounded federation call, preserving safety's dispatch fence.
 */
export type HiggsfieldRuntimeBinding = {
  readonly adapter: PollingVendorAdapter;
  readonly signer: RequestSigner;
  readonly httpClient: NonNullable<OperationRuntimeDeps["httpClient"]>;
  readonly awaitHandoff: () => Promise<Outcome<void>>;
};

/** Typed errors only at Jini's exception-based foreign adapter ABI; messages never contain raw output. */
export class HiggsfieldBoundaryError extends Error {
  readonly code: AppError["code"];
  constructor(required: { code: AppError["code"]; message: string }) {
    super(required.message);
    this.name = "HiggsfieldBoundaryError";
    this.code = required.code;
  }
}
