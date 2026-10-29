import type { CallContext, CallOptions, Outcome, Scope, TimeWindow } from "@open-marketing/contracts";
import { epochSchema } from "@open-marketing/contracts";
import { z } from "zod";
const clickIdentifierSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9._-]+$/).refine(value => value.trim() === value);

/** Visitor-controlled attribution claims; ordinary UTMs never establish paid attribution.
 * Ingress supplies authenticated identity/scope separately. The query/fragment-free page origin+path is
 * kept only in the mutable touch map (as event_source_url, with the server-captured client_user_agent)
 * and purged on erasure. client_user_agent is server-supplied after visitor consent; ingress rejects it from browsers. */
export const landingPropertiesSchema = z.strictObject({
  linkId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).refine(value => value.trim() === value).optional(),
  campaignId: z.string().max(256).optional(),
  utm_source: z.string().max(256).optional(), utm_medium: z.string().max(256).optional(),
  om_a: z.string().max(256).optional(), utm_id: z.string().max(256).optional(),
  pageUrl: z.url({ protocol: /^https$/ }).max(2048).refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password;
  }).optional(),
  gclid: clickIdentifierSchema.optional(), gbraid: clickIdentifierSchema.optional(),
  wbraid: clickIdentifierSchema.optional(), fbclid: clickIdentifierSchema.optional(),
  client_user_agent: z.string().min(1).max(1024).optional(),
});
export type LandingProperties = z.infer<typeof landingPropertiesSchema>;
/** Collector evidence only: ready means an accepted landing within the last seven days. */
export const destinationReadinessSchema = z.strictObject({ status: z.enum(["missing", "stale", "ready"]), heartbeatAt: epochSchema.nullable() });
export type DestinationReadiness = z.infer<typeof destinationReadinessSchema>;

/** One envelope for collection, attribution and later event consumers.
 * Ingress limits: properties <=32 keys, each string <=2048 chars, total JSON <=16 KiB.
 * Property values are JSON scalars; addresses/answers are excluded. Cursor is server-assigned and monotonic. */
export interface WebEvent {
  readonly eventId: string;
  readonly schema: string;
  readonly version: number;
  readonly source: string;
  readonly subjectId?: string;
  readonly anonymousId?: string;
  readonly name: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly cursor: number;
  readonly traceId: string;
}
/** Visit tokens bind a workspace-scoped anonymous visit and expiry; never grant marketing authority. */
export interface Visit { readonly visitId: string; readonly scope: Scope; readonly anonymousId: string; readonly subjectId: string | null; readonly expiresAt: number }
/** Click IDs are short-lived PII and privacy participants, excluded from immutable ledgers. */
export interface AttributionTouch {
  readonly touchId: string;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly linkId: string | null;
  readonly campaignId: string | null;
  readonly clickIdentifiers: Readonly<Record<string, string>>;
}
/** Frozen collection API; adapters validate authority, scope, bounds and visit tokens at ingress. */
export interface WebEventService {
  recordTouch(required: { context: CallContext; event: WebEvent }, optional?: CallOptions): Promise<Outcome<AttributionTouch>>;
  bindVisitor(required: { context: CallContext; visitToken: string; subjectId: string }, optional?: CallOptions): Promise<Outcome<Visit>>;
  touchesFor(required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number }, optional?: CallOptions): Promise<Outcome<readonly AttributionTouch[]>>;
  /** Exact HTTPS origin/path; does not prove reachability or vendor delivery. */
  destinationReadiness(required: { context: CallContext; destinationUrl: string }, optional?: CallOptions): Promise<Outcome<DestinationReadiness>>;
}
