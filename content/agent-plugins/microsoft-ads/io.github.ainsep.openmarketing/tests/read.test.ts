import { expect, it } from "vitest";
import { createMicrosoftAdsAdapter } from "../src/index.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";
import { fixture, invocation, campaignPage } from "./fixtures.js";
dispatchSuite({ name: "memory", makeFixture: fixture });
it("supports account-less authenticated discovery with explicit paging", async () => {
  const f = fixture(); const dependencies = { ...f.dependencies, configuration: { ...f.dependencies.configuration, accountId: null, customerId: null, currency: null } };
  f.state.responses = [{ User: { Id: 345, Email: "private" } }, { Accounts: [{ Id: 123, ParentCustomerId: 234, Name: "Fixture", CurrencyCode: "USD", AccountLifeCycleStatus: "Active" }] }];
  const result = await createMicrosoftAdsAdapter(dependencies).invoke(invocation({ command: { kind: "list_accounts", pageIndex: 2, pageSize: 1 } }));
  expect(result).toMatchObject({ ok: true, value: { data: { nextPageIndex: 3, items: [{ Id: "123" }] } } });
  expect(JSON.parse(String(f.calls[1].init.body))).toMatchObject({ Predicates: [{ Field: "UserId", Value: "345" }], PageInfo: { Index: 2, Size: 1 } });
});
it("denies static non-admission and cancellation before all effects", async () => {
  const f = fixture(); const dependencies = { ...f.dependencies, configuration: { ...f.dependencies.configuration, admitted: false } };
  expect(await createMicrosoftAdsAdapter(dependencies).invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await f.adapter.invoke(invocation(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it("rejects invalid inputs, foreign scope and duplicate/unsafe provider IDs", async () => {
  const f = fixture();
  expect(await f.adapter.invoke({ ...invocation(), command: { kind: "list_campaigns", accessToken: "bad" } } as never)).toMatchObject({ ok: false });
  expect(await f.adapter.invoke({ ...invocation(), context: { ...invocation().context, scope: { ownerId: "other", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.credentials).toEqual([]);
  for (const items of [[...campaignPage.Campaigns, ...campaignPage.Campaigns], [{ ...campaignPage.Campaigns[0], Id: 9007199254740992 }]]) {
    f.state.responses = [{ Campaigns: items }]; expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  }
});
it("returns the validated operation ID when the caller mutates its input during execution", async () => {
  const f = fixture(); const input = { ...invocation() };
  f.state.hook = () => { input.operationId = "changed-operation"; };
  expect(await f.adapter.invoke(input)).toMatchObject({ ok: true, value: { operationId: "operation" } });
  expect(input.operationId).toBe("changed-operation");
  expect(f.dispatches[0].effect.operationId).toBe("operation");
});
it("uses the injected 15-second RPC timeout without retrying", async () => {
  const f = fixture(); f.state.fetchHook = () => f.advanceTime({ milliseconds: 15000 });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(f.timeouts.map(timeout => timeout.milliseconds)).toEqual([60000, 15000]);
  expect(f.timeouts[0].controller.signal.aborted).toBe(false);
  expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true);
});
it("expires an in-flight RPC when the injected total deadline fires", async () => {
  const f = fixture(); f.state.fetchHook = () => f.advanceTime({ milliseconds: 60000 });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(f.timeouts[0].milliseconds).toBe(60000); expect(f.timeouts[0].controller.signal.aborted).toBe(true);
  expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true);
});
it("rejects a late successful RPC even if the injected fetch ignores cancellation", async () => {
  const f = fixture();
  const adapter = createMicrosoftAdsAdapter({ ...f.dependencies, fetch: async () => {
    f.advanceTime({ milliseconds: 60000 });
    return new Response(JSON.stringify(campaignPage), { status: 200 });
  } });
  expect(await adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "expired" } });
});
it("preserves caller cancellation while an RPC is pending", async () => {
  const f = fixture(); const controller = new AbortController();
  f.state.fetchHook = () => controller.abort();
  expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.timeouts[0].controller.signal.aborted).toBe(false);
  expect(f.calls).toHaveLength(1); expect(f.calls[0].init.signal?.aborted).toBe(true);
});
