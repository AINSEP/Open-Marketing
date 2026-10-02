import { assertEpochMilliseconds } from "@open-marketing/om-clock";
import { failureCompletion, validateRetryPolicy } from "./retry.js";
import type { AbortSignalPort, Completion, EnqueueRequest, EnqueueResult, OutboxEvent, OutboxJob, OutboxPorts, ProcessResult, RetryPolicy, TransportResult } from "./types.js";

/** Construct a timer-free outbox service. Call processOne from a host-owned scheduler.
 * Store failures propagate: never repeat an external operation merely because its ack failed.
 * @complexity O(1) local work/space per operation plus injected adapter work. @overallScore 100
 */
export function createOutbox(ports: OutboxPorts, inputPolicy: RetryPolicy) {
  validateRetryPolicy(inputPolicy);
  const policy = Object.freeze({ ...inputPolicy });

  /** Observer failure is isolated from persistence/transport semantics. @complexity O(1). @overallScore 100 */
  function observe(event: OutboxEvent): void {
    try { ports.observe?.(event); } catch { /* Telemetry must not cause duplicate delivery. */ }
  }
  /** Validate injected epoch time before storage transitions. @complexity O(1). @overallScore 100 */
  function now(): number {
    const value = ports.clock.now();
    assertEpochMilliseconds(value);
    return value;
  }
  /** Complete only while the claim fence remains live. Adapter errors propagate. @complexity O(1). @overallScore 100 */
  async function complete(job: OutboxJob, completion: Completion): Promise<ProcessResult> {
    const applied = await ports.store.complete({ id: job.id, tenantId: job.tenantId, token: job.leaseToken!, now: now() }, completion);
    observe({ operation: "complete", outcome: applied ? completion.state : "stale" });
    return applied ? { kind: "completed", state: completion.state, jobId: job.id } : { kind: "stale" };
  }

  return Object.freeze({
    /** Persist one opaque request. Caller computes its canonical digest; adapters validate untrusted input.
     * Duplicate tenant/key returns the prior job, or conflict for different content. No payload logging.
     * @complexity O(1) local work plus input length validation/storage. @overallScore 100
     */
    async enqueue(input: EnqueueRequest): Promise<EnqueueResult> {
      if (![input.tenantId, input.idempotencyKey, input.requestDigest, input.operation].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 256) || typeof input.payload !== "string" || input.payload.length > 262144) throw new TypeError("Invalid or oversized outbox request");
      const time = now();
      const id = ports.generateId();
      if (!id.trim()) throw new TypeError("Empty outbox ID");
      const result = await ports.store.enqueue({ ...input, id, createdAt: time, availableAt: time, state: "pending", attempts: 0, leaseToken: null, leaseExpiresAt: null });
      observe({ operation: "enqueue", outcome: result.kind });
      return result;
    },

    /** Claim at most one job, refresh authorization and dispatch once. No sleeps or timers.
     * Thrown transport errors and in-flight cancellation are uncertain outcomes, never known failures.
     * @complexity O(1) local work/space plus atomic adapter operations. @overallScore 100
     */
    async processOne(signal?: AbortSignalPort): Promise<ProcessResult> {
      if (signal?.aborted) return { kind: "aborted" };
      const time = now();
      const leaseExpiresAt = time + policy.leaseMs;
      if (!Number.isSafeInteger(leaseExpiresAt)) throw new RangeError("Outbox lease exceeds epoch range");
      const recovered = await ports.store.recoverExpired({ now: time, limit: 100 });
      observe({ operation: "recovery", outcome: recovered > 0 ? "reconcile" : "none" });
      const leaseToken = ports.generateId();
      if (!leaseToken.trim()) throw new TypeError("Empty outbox lease token");
      const job = await ports.store.claim({ now: time, leaseToken, leaseExpiresAt, maxAttempts: policy.maxAttempts });
      observe({ operation: "claim", outcome: job ? "claimed" : "idle" });
      if (!job) return { kind: "idle" };
      if (signal?.aborted) return complete(job, failureCompletion("transient", job.attempts, now(), policy, false));
      let authorized: boolean;
      try { authorized = await ports.authorize(job); }
      catch {
        observe({ operation: "authorization", outcome: "unavailable" });
        return complete(job, failureCompletion("transient", job.attempts, now(), policy, false));
      }
      observe({ operation: "authorization", outcome: authorized ? "allowed" : "denied" });
      if (!authorized) return complete(job, { state: "denied" });
      if (signal?.aborted) return complete(job, failureCompletion("transient", job.attempts, now(), policy, false));
      const live = await ports.store.beginDispatch({ id: job.id, tenantId: job.tenantId, token: job.leaseToken!, now: now() });
      if (!live) return { kind: "stale" };
      let result: TransportResult;
      const request: EnqueueRequest = { tenantId: job.tenantId, idempotencyKey: job.idempotencyKey, requestDigest: job.requestDigest, operation: job.operation, payload: job.payload };
      try { result = await ports.transport.dispatch(request, signal); }
      catch { result = { kind: "failure", classification: "unknown" }; }
      observe({ operation: "dispatch", outcome: result.kind === "success" ? "success" : result.classification });
      return complete(job, result.kind === "success" ? { state: "succeeded" } : failureCompletion(result.classification, job.attempts, now(), policy, ports.transport.idempotent));
    },
  });
}
