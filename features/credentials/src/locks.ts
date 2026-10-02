/// <reference lib="esnext.promise" />
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { CredentialReference } from "./types.js";
import type { CredentialLockPort } from "./ports.js";
import { boundary, failure, referenceSchema, scopeKey } from "./rules.js";

interface Waiter { resolve: (value: Outcome<{ readonly lockId: string }>) => void; signal?: AbortSignal; abort: () => void; cancelled: boolean }
interface Queue { lockId: string; waiting: Waiter[] }

/** FIFO process-local lock double/server adapter. All versions share one scoped queue.
 * Caller supplies cancellation/deadlines; no timers or background tasks start here.
 * @complexity O(1) acquire, O(waiters) release; bounded queues and connection count.
 * @tradeoffs Single server process only; multi-process hosts require a shared lock adapter.
 */
export function createMemoryCredentialLock(required: { maxConnections?: number; maxWaiters?: number }): CredentialLockPort {
  const queues = new Map<string, Queue>();
  const held = new Map<string, string>();
  let sequence = 0;
  function grant(input: { key: string; waiting: Waiter[] }): Outcome<{ readonly lockId: string }> {
    const lockId = `credential-lock-${++sequence}`;
    queues.set(input.key, { lockId, waiting: input.waiting });
    held.set(lockId, input.key);
    return { ok: true, value: { lockId } };
  }
  return {
    async acquire(input, options) {
      if (!referenceSchema.safeParse(input.reference).success) return failure({ code: "invalid_input" });
      if (options?.signal?.aborted) return failure({ code: "cancelled" });
      const key = scopeKey(input.reference);
      const queue = queues.get(key);
      if (!queue && queues.size >= (required.maxConnections ?? 1024)) return failure({ code: "limit_exceeded" });
      if (!queue) return grant({ key, waiting: [] });
      if (queue.waiting.length >= (required.maxWaiters ?? 128)) return failure({ code: "limit_exceeded" });
      return waitForLock({ queue }, options);
    },
    async release(input) {
      const key = held.get(input.lockId);
      if (!key) return failure({ code: "conflict" });
      held.delete(input.lockId);
      const queue = queues.get(key);
      if (!queue) return failure({ code: "conflict" });
      const waiter = nextWaiter({ queue });
      if (!waiter) { queues.delete(key); return { ok: true, value: undefined }; }
      waiter.resolve(grant({ key, waiting: queue.waiting }));
      return { ok: true, value: undefined };
    },
  };
}
/** Foreign Promise/event callback ABIs are narrow wrappers; abort never grants authority. @complexity O(1). */
function waitForLock(required: { queue: Queue }, optional?: CallOptions): Promise<Outcome<{ readonly lockId: string }>> {
  const deferred = Promise.withResolvers<Outcome<{ readonly lockId: string }>>();
  const waiter: Waiter = { resolve: deferred.resolve, signal: optional?.signal, cancelled: false, abort() {
    waiter.cancelled = true;
    deferred.resolve(failure({ code: "cancelled" }));
  } };
  required.queue.waiting.push(waiter);
  optional?.signal?.addEventListener("abort", waiter.abort, { once: true });
  return deferred.promise;
}
/** Remove cancelled waiters and their listeners before granting the next lease. @complexity O(waiters), bounded to 128 by default. */
function nextWaiter(required: { queue: Queue }): Waiter | undefined {
  let waiter = required.queue.waiting.shift();
  while (waiter) {
    waiter.signal?.removeEventListener("abort", waiter.abort);
    if (!waiter.cancelled) return waiter;
    waiter = required.queue.waiting.shift();
  }
  return undefined;
}

/** Hold a credential lock until all awaited effects settle. Always release despite cancellation
 * or boundary exceptions; release failures are typed failures, never hidden success. @complexity O(1) plus protected work.
 */
export async function withCredentialLock<T>(required: { locks: CredentialLockPort; reference: CredentialReference; run: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  const acquired = await boundary({ run: () => required.locks.acquire({ reference: required.reference }, optional) }, optional);
  if (!acquired.ok) return acquired;
  const result = await boundary({ run: required.run }, optional);
  const released = await boundary({ run: () => required.locks.release({ lockId: acquired.value.lockId }) });
  if (!released.ok) return released;
  return result;
}
