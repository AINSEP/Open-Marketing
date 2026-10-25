/** Single dispatch-owning process only; never hold SQLite while acquiring this lane. */
import { TurnLock } from '@jini-ai/db/kernel';
import { z } from 'zod';
import { callContextSchema, idSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, Outcome } from '@open-marketing/contracts';
import type { ContactRepoPort } from '@open-marketing/contacts';
import { localFailure } from './local-auth.js';

type Entry = { lock: TurnLock; users: number };
type Input<T> = z.infer<typeof inputSchema> & { work(required: { subjectIds: readonly string[] }): Promise<Outcome<T>> };
const inputSchema = z.object({ context: callContextSchema, subjectIds: z.array(idSchema).max(2).readonly() });
/** Serialize complete families, revalidate after acquisition, and retain ownership through work.
 * Waiting aborts drain their acquired locks before returning; work is never raced against a timer.
 * Fixed bounds: 100 family members, 1024 active keys, 32 holders/waiters per key. Idle keys disappear.
 * @example lane.run({ context, subjectIds: [subjectId], work }, { signal });
 * @complexity O(s log s) space/time plus <=4 owning reads for s<=100 family keys.
 */
export function createSubjectLane(required: { resolveSubject: ContactRepoPort['get'] }) {
    const entries = new Map<string, Entry>();
    async function family(input: { context: CallContext; subjectIds: readonly string[] }): Promise<Outcome<string[]>> {
        const ids = new Set<string>();
        for (const subjectId of input.subjectIds) {
            const root = await required.resolveSubject({ context: input.context, subjectId });
            if (!root.ok) return root;
            if (!root.value) return localFailure({ message: 'Subject unavailable' });
            if (root.value.scope.ownerId !== input.context.scope.ownerId || root.value.scope.workspaceId !== input.context.scope.workspaceId) return localFailure({ code: 'forbidden', message: 'Foreign subject' });
            for (const id of [root.value.subjectId, ...root.value.lineage.map(item => item.sourceSubjectId)]) ids.add(id);
        }
        if (ids.size > 100) return localFailure({ code: 'limit_exceeded', message: 'Subject lineage exceeds bound' });
        return { ok: true, value: [...ids].sort() };
    }
    /** Reserve users before awaiting so cleanup cannot orphan a waiter on a different lock. */
    function reserve(input: { context: CallContext; subjectIds: readonly string[] }): Outcome<{ key: string; entry: Entry }[]> {
        const keys = input.subjectIds.map(id => JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId, id]));
        const added = keys.filter(key => !entries.has(key)).length;
        if (entries.size + added > 1024 || keys.some(key => (entries.get(key)?.users ?? 0) >= 32)) return localFailure({ code: 'limit_exceeded', message: 'Subject lane capacity reached' });
        return { ok: true, value: keys.map(key => {
            const entry = entries.get(key) ?? { lock: new TurnLock(), users: 0 };
            entry.users++; entries.set(key, entry); return { key, entry };
        }) };
    }
    async function locked<T>(input: Input<T> & { family: string[] }, options?: CallOptions): Promise<Outcome<T>> {
        const reserved = reserve({ context: input.context, subjectIds: input.family });
        if (!reserved.ok) return reserved;
        const held: Entry[] = [];
        try {
            for (const { entry } of reserved.value) { await entry.lock.acquire('exclusive'); held.push(entry); }
            if (options?.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Subject lane cancelled' });
            const current = await family(input);
            if (!current.ok) return current;
            if (options?.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Subject lane cancelled' });
            if (JSON.stringify(current.value) !== JSON.stringify(input.family)) return localFailure({ code: 'conflict', message: 'Subject lineage changed' });
            return await input.work({ subjectIds: current.value });
        } finally {
            for (const entry of held.reverse()) entry.lock.release('exclusive');
            for (const { key, entry } of reserved.value) { entry.users--; if (entry.users === 0) entries.delete(key); }
        }
    }
    return { async run<T>(input: Input<T>, options?: CallOptions): Promise<Outcome<T>> {
        try {
            const parsed = inputSchema.safeParse(input);
            if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid subject lane input' });
            if (options?.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Subject lane cancelled' });
            const resolved = await family(parsed.data);
            if (!resolved.ok) return resolved;
            return await locked({ ...parsed.data, work: input.work, family: resolved.value }, options);
        } catch { return localFailure({ message: 'Subject operation unavailable; reconcile any started attempt' }); }
    } };
}
