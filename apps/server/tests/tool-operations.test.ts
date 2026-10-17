/** Shared write-through contract: fixtures only, never invokes a tool. Written, not run. */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CallContext, Outcome } from '@open-marketing/contracts';
import { digestArguments } from '@open-marketing/safety';
import { createMemoryToolOperationStore, createSqlToolOperationStore } from '../src/tool-operations.js';
import type { StoredToolOperation } from '../src/om-tool-types.js';
import { bindServerDatabase } from '../src/composition/database.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'correlation', traceId: 'trace' };
function value<T>(input: { outcome: Outcome<T> }): T {
    if (!input.outcome.ok) throw new Error(input.outcome.error.message);
    return input.outcome.value;
}
function operation(input: { operationId?: string } = {}): StoredToolOperation {
    const call = { name: 'fixture_write', input: { value: 7 }, operationId: input.operationId ?? 'operation' };
    const args = { tool: call.name, input: call.input };
    const digest = value({ outcome: digestArguments({ arguments: args }) });
    return { context, call, digest, revision: digest, policy: 'write', classification: 'write', expiresAt: 301000,
        state: { status: 'pending', operationId: call.operationId }, executing: false,
        request: { arguments: args, pluginDigest: digest, schemaFingerprint: digest, operationScope: call.name,
            envelope: { operationId: call.operationId, connectionId: call.name, accountId: null, effects: ['write'], argumentsDigest: digest, moneyExposure: null, requiredLimit: null } } };
}
for (const backend of ['memory', 'sql'] as const) describe('ToolOperationStore B1 / ' + backend, () => {
    function fixture() {
        const native = new Database(':memory:');
        native.exec(readFileSync(new URL('../migrations/0003_tool_operations.sql', import.meta.url), 'utf8'));
        const { unit } = bindServerDatabase({ native, context, observer: { observe() {} } });
        const memory = createMemoryToolOperationStore({});
        return { native, open: () => backend === 'memory' ? memory : createSqlToolOperationStore({ unit }) };
    }
    it('upserts snapshots, reopens terminals, and isolates owner/workspace without retaining references', async () => {
        const f = fixture();
        try {
            const store = f.open(); const record = operation();
            value({ outcome: await store.save({ context, operation: record }) });
            record.state = { status: 'completed', operationId: record.call.operationId, output: { saved: 7 } };
            expect(value({ outcome: await store.loadOpen({ scope: context.scope }) })[0].state.status).toBe('pending');
            value({ outcome: await store.save({ context, operation: record }) });
            const reopened = f.open();
            const restored = value({ outcome: await reopened.loadOpen({ scope: context.scope }) });
            expect(restored).toEqual([record]);
            restored[0].executing = true;
            expect(value({ outcome: await reopened.loadOpen({ scope: context.scope }) })[0].executing).toBe(false);
            for (const scope of [{ ...context.scope, ownerId: 'other' }, { ...context.scope, workspaceId: 'other' }])
                expect(await reopened.loadOpen({ scope })).toEqual({ ok: true, value: [] });
            expect(await reopened.save({ context: { ...context, scope: { ...context.scope, workspaceId: 'other' } }, operation: record })).toMatchObject({ ok: false, error: { retryable: false } });
        } finally { f.native.close(); }
    });
    it('retains dispatching snapshots and refuses oversized or malformed records', async () => {
        const f = fixture();
        try {
            const store = f.open(); const record = operation(); record.executing = true;
            value({ outcome: await store.save({ context, operation: record }) });
            expect(value({ outcome: await f.open().loadOpen({ scope: context.scope }) })[0].executing).toBe(true);
            if (backend === 'sql') expect(f.native.prepare('SELECT status FROM server_tool_operations').get()).toEqual({ status: 'dispatching' });
            const invalid = { ...record, call: { ...record.call, operationId: 'different' } };
            expect(await store.save({ context, operation: invalid })).toMatchObject({ ok: false, error: { retryable: false } });
            const oversized = { ...record, request: { ...record.request, arguments: { large: 'x'.repeat(262144) } } };
            expect(await store.save({ context, operation: oversized })).toMatchObject({ ok: false, error: { retryable: false } });
        } finally { f.native.close(); }
    });
    it('bounds retention at 256 without dropping earlier identities', async () => {
        const f = fixture();
        try {
            const store = f.open();
            for (let index = 0; index < 256; index++) value({ outcome: await store.save({ context, operation: operation({ operationId: 'op-' + index }) }) });
            expect(await store.save({ context, operation: operation({ operationId: 'overflow' }) })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
            expect(value({ outcome: await f.open().loadOpen({ scope: context.scope }) })).toHaveLength(256);
            value({ outcome: await store.save({ context, operation: operation({ operationId: 'op-0' }) }) });
        } finally { f.native.close(); }
    });
    it('compacts terminal bodies, preserves exact replay outcomes and frees capacity', async () => {
        const f = fixture();
        try {
            const store = f.open();
            const terminal = operation({ operationId: 'oldest-z' });
            terminal.state = { status: 'completed', operationId: terminal.call.operationId, output: { saved: 7 } };
            value({ outcome: await store.save({ context, operation: terminal }) });
            for (let index = 1; index < 256; index++) value({ outcome: await store.save({ context, operation: operation({ operationId: 'op-' + index }) }) });
            expect(value({ outcome: await store.loadOpen({ scope: context.scope }) })[0]).toEqual(terminal);
            value({ outcome: await store.archive({ context, operation: terminal }) });
            value({ outcome: await store.save({ context, operation: operation({ operationId: 'new' }) }) });
            expect(value({ outcome: await f.open().loadOpen({ scope: context.scope }) })).toHaveLength(256);
            const replay = value({ outcome: await f.open().replay({ context, operationId: terminal.call.operationId }) })!;
            expect(replay.call.input).toEqual({}); expect(replay.request.arguments).toEqual({});
            expect(replay.digest).toBe(terminal.digest); expect(replay.state).toEqual(terminal.state);
            for (const scope of [{ ...context.scope, ownerId: 'other' }, { ...context.scope, workspaceId: 'other' }])
                expect(await store.replay({ context: { ...context, scope }, operationId: terminal.call.operationId })).toEqual({ ok: true, value: null });
            replay.state = { status: 'cancelled', operationId: terminal.call.operationId };
            expect(value({ outcome: await store.replay({ context, operationId: terminal.call.operationId }) })?.state).toEqual(terminal.state);
            expect(await store.archive({ context, operation: operation() })).toMatchObject({ ok: false, error: { retryable: false } });
            expect(await store.archive({ context, operation: { ...terminal, executing: true } })).toMatchObject({ ok: false, error: { retryable: false } });
            expect(await store.archive({ context: { ...context, scope: { ...context.scope, ownerId: 'other' } }, operation: terminal })).toMatchObject({ ok: false });
        } finally { f.native.close(); }
    });
});
