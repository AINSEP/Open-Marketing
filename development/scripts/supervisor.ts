import type { Outcome } from '@open-marketing/contracts';
export type ServiceChild = 'server' | 'agent';
export interface ChildHandle { stop(required: Record<string, never>): Promise<Outcome<void>> }
export interface ChildProcessPort { spawn(required: { child: ServiceChild }): Promise<Outcome<ChildHandle>> }
/** Development process ownership only. API reload never owns agent lifetime. No hidden global child registry. */
export function createSupervisor(required: { processes: ChildProcessPort }) {
 const children = new Map<ServiceChild, ChildHandle>();
 return {
  async start(input: { child: ServiceChild }): Promise<Outcome<void>> {
   if (children.has(input.child)) return { ok: false, error: { code: 'conflict', message: 'Child already owned', retryable: false } };
   const spawned = await required.processes.spawn(input);
   if (!spawned.ok) return spawned;
   children.set(input.child, spawned.value); return { ok: true, value: undefined };
  },
  async stop(input: { child: ServiceChild }): Promise<Outcome<void>> {
   const child = children.get(input.child);
   if (!child) return { ok: true, value: undefined };
   const outcome = await child.stop({});
   if (outcome.ok) children.delete(input.child);
   return outcome;
  },
 };
}
