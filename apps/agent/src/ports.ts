import type { Outcome, StartRunRequest, CancelRunRequest, RunReceipt, CancellationReceipt, EventSubscription, RunEvent } from "@open-marketing/contracts";
/** Host-owned resources. Construction/import is inert; start/stop are explicit. */
export interface LifecyclePort { start(required: Record<string, never>): Promise<Outcome<void>>; stop(required: Record<string, never>): Promise<Outcome<void>> }
export interface HttpRequest { readonly path: string; readonly method: "GET" | "POST"; readonly authorization?: string; readonly body?: unknown; readonly query?: unknown }
export interface HttpResponse { readonly status: number; readonly body: unknown }
export interface HttpListenerPort { start(required: { handle: (required: HttpRequest) => Promise<HttpResponse> }): Promise<Outcome<void>>; stop(required: Record<string, never>): Promise<Outcome<void>> }
export interface JiniRuntimePort {
 startRun(required: StartRunRequest): Promise<Outcome<RunReceipt>>;
 cancelRun(required: CancelRunRequest): Promise<Outcome<CancellationReceipt>>;
 events(required: EventSubscription): Promise<Outcome<readonly RunEvent[]>>;
}
