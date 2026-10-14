import type { CallContext, Outcome, StartRunRequest, CancelRunRequest, RunReceipt, CancellationReceipt, EventSubscription, RunEvent } from "@open-marketing/contracts";
import type { z } from "zod";
import type { routes } from "./cli/http.js";
/** Owner operations derive all scope/grants on the server; no prompt or credential is returned. */
export interface OwnerRunPort {
    start(required: { context: CallContext; prompt: string }, optional?: { conversationId?: string; frontendSessionId?: string }): Promise<Outcome<z.infer<typeof routes.ask.schema>>>;
    events(required: { context: CallContext; runId: string; after: number }): Promise<Outcome<z.infer<typeof routes.runEvents.schema>>>;
    cancel(required: { context: CallContext; runId: string }): Promise<Outcome<z.infer<typeof routes.cancelRun.schema>>>;
}
/** Host-owned resources. Construction/import is inert; start/stop are explicit. */
export interface LifecyclePort { start(required: Record<string, never>): Promise<Outcome<void>>; stop(required: Record<string, never>): Promise<Outcome<void>> }
/** Transport metadata is available before the bounded, lazy body reader. Existing in-memory
 * callers may still supply body directly. Query values are unique; duplicates fail at ingress. */
export interface HttpRequest {
 readonly path: string;
 readonly method: "GET" | "POST";
 readonly authorization?: string;
 readonly headers?: Readonly<Record<string, string | undefined>>;
 readonly query?: Readonly<Record<string, string>>;
 readonly body?: unknown;
 /** Aborted on client disconnect or listener shutdown. */
 readonly signal?: AbortSignal;
 readonly readBody?: (required: Record<string, never>) => Promise<Outcome<unknown>>;
}
/** JSON by default; contentType selects HTML/text/bytes. Headers never contain tainted values. */
export interface HttpResponse {
 readonly status: number;
 readonly body: unknown;
 readonly contentType?: string;
 readonly headers?: Readonly<Record<string, string>>;
 /** Lazy bytes; the listener owns cancellation, including before iteration begins. */
 readonly stream?: { readonly chunks: AsyncIterable<Uint8Array>; cancel(required: Record<string, never>): Promise<void> };
}
export interface HttpListenerPort { start(required: { handle: (required: HttpRequest) => Promise<HttpResponse> }): Promise<Outcome<void>>; stop(required: Record<string, never>): Promise<Outcome<void>> }
export interface JiniRuntimePort {
 startRun(required: StartRunRequest): Promise<Outcome<RunReceipt>>;
 cancelRun(required: CancelRunRequest): Promise<Outcome<CancellationReceipt>>;
 events(required: EventSubscription): Promise<Outcome<readonly RunEvent[]>>;
}
