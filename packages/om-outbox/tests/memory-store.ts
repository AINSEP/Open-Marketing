import type { Completion, EnqueueResult, LeaseFence, OutboxJob, OutboxStore } from "../src/types.js";

/** TEST ONLY. Single-process synchronous mutations simulate atomic transitions; no durability. */
export class MemoryStore implements OutboxStore {
  private readonly jobs = new Map<string, OutboxJob>();
  snapshot(): readonly OutboxJob[] { return [...this.jobs.values()].map(job => ({ ...job })); }
  async enqueue(job: OutboxJob): Promise<EnqueueResult> {
    const existing = [...this.jobs.values()].find(value => value.tenantId === job.tenantId && value.idempotencyKey === job.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== job.requestDigest || existing.operation !== job.operation || existing.payload !== job.payload) return { kind: "conflict" };
      return { kind: "existing", job: { ...existing } };
    }
    if (this.jobs.has(job.id)) throw new Error("Duplicate generated ID");
    this.jobs.set(job.id, { ...job });
    return { kind: "inserted", job: { ...job } };
  }
  async recoverExpired({ now, limit }: { now: number; limit: number }): Promise<number> {
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (recovered >= limit) break;
      if ((job.state === "leased" || job.state === "dispatching") && job.leaseExpiresAt! <= now) {
        this.jobs.set(job.id, { ...job, state: "reconcile", leaseToken: null, leaseExpiresAt: null });
        recovered++;
      }
    }
    return recovered;
  }
  async claim(input: { now: number; leaseToken: string; leaseExpiresAt: number; maxAttempts: number }): Promise<OutboxJob | null> {
    const job = [...this.jobs.values()].find(value => (value.state === "pending" || value.state === "retry") && value.availableAt <= input.now && value.attempts < input.maxAttempts);
    if (!job) return null;
    const claimed: OutboxJob = { ...job, state: "leased", attempts: job.attempts + 1, leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt };
    this.jobs.set(job.id, claimed);
    return { ...claimed };
  }
  private fenced(fence: LeaseFence): OutboxJob | undefined {
    const job = this.jobs.get(fence.id);
    return job && job.tenantId === fence.tenantId && job.leaseToken === fence.token && job.leaseExpiresAt! > fence.now && (job.state === "leased" || job.state === "dispatching") ? job : undefined;
  }
  async beginDispatch(fence: LeaseFence): Promise<boolean> {
    const job = this.fenced(fence);
    if (!job || job.state !== "leased") return false;
    this.jobs.set(job.id, { ...job, state: "dispatching" });
    return true;
  }
  async complete(fence: LeaseFence, completion: Completion): Promise<boolean> {
    const job = this.fenced(fence);
    if (!job) return false;
    this.jobs.set(job.id, { ...job, ...completion, leaseToken: null, leaseExpiresAt: null });
    return true;
  }
}
