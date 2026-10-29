/** @vitest-environment jsdom */
import { afterEach, it, expect } from "vitest";
import { createElement } from "react";
import { render, renderHook, screen, cleanup, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Shell } from "../src/app/shell/Shell.js";
import { useOMChatPane } from "../src/widgets/om-chat/OMChatPane.hooks.js";
import { testStudio } from "./support/studio.js";

afterEach(() => { cleanup(); localStorage.clear(); });
it("keyboard opens the global panel, Escape closes it, and focus returns to the FAB", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByRole("heading", { name: "Workspace overview", level: 2 });
    const fab = screen.getByRole("button", { name: "Assistant" });
    fab.focus(); await user.keyboard("{Enter}");
    expect(fab.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Assistant" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(fab.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(fab);
  } finally { host.dispose(); }
});
it("a sample chat requests native navigation and acknowledges only the rendered canvas", async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByRole("heading", { name: "Workspace overview", level: 2 });
    await user.click(screen.getByRole("button", { name: "Assistant" }));
    await user.type(screen.getByPlaceholderText("Ask the assistant to do something…"), "open campaigns");
    await user.click(screen.getByRole("button", { name: "Send" }));
    for (let index = 0; index < 4; index += 1) await act(async () => { host.timer.advance({ ms: 450 }); });
    expect(screen.getByRole("heading", { name: "Campaigns", level: 1 })).toBeDefined();
    expect(screen.getByText("Opened campaigns in this browser.")).toBeDefined();
    expect(host.props.session.getSnapshot().navigation).toEqual({ status: "completed", actionId: expect.any(String), target: "campaigns" });
  } finally { host.dispose(); }
});

it('closing the dock preserves the Jini draft; New chat resets it', async () => {
  const host = testStudio();
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByRole('heading', { name: 'Workspace overview', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    await user.type(screen.getByPlaceholderText('Ask the assistant to do something…'), 'Keep this draft');
    await user.click(screen.getByRole('button', { name: 'Close assistant' }));
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    expect(screen.getByDisplayValue('Keep this draft')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByDisplayValue('Keep this draft')).toBeNull();
    expect(host.props.session.getSnapshot().conversationId).toBeNull();
    expect(screen.getByRole('button', { name: 'Reasoning: Default' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Model: Sample Large' })).toBeDefined();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  } finally { host.dispose(); }
});

it('loads the chosen server conversation into Jini and uses server model choices with the existing settings write', async () => {
  const host = testStudio(), writes: unknown[] = [];
  const settings = { mode: 'sandbox' as 'sandbox' | 'model', provider: 'acme-models', model: 'fixture-model', connectionId: 'connection' };
  const models = [{ id: 'fixture-model', label: 'Fixture model from server' }];
  const runtimes = [{ id: 'acme-models', name: 'Acme models', available: true, authStatus: 'ok' as const, models, reasoningOptions: [] }];
  host.props.api.settings = async () => ({ ok: true, value: { settings, models, runtimes, ready: true, status: 'ready' } });
  host.props.api.setSettings = async input => { writes.push(input.settings); return { ok: true, value: { settings: input.settings, models, runtimes, ready: true, status: 'ready' } }; };
  host.props.api.conversations = async () => ({ ok: true, value: { items: [{ conversationId: 'saved', title: 'Saved chat', createdAt: 1000, updatedAt: 1000 }], cursor: null } });
  host.props.api.conversation = async () => ({ ok: true, value: { conversation: { conversationId: 'saved', title: 'Saved chat', createdAt: 1000, updatedAt: 1000 }, messages: [{ id: 'reply', role: 'assistant', text: 'Saved answer from the server' }], cursor: null } });
  try {
    const user = userEvent.setup(); render(createElement(Shell, host.props));
    await screen.findByRole('heading', { name: 'Workspace overview', level: 2 });
    await act(() => host.props.session.refresh());
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    await user.click(screen.getByRole('button', { name: 'Chat history' }));
    await user.click(screen.getByRole('button', { name: 'Saved chat' }));
    expect(await screen.findByText('Saved answer from the server')).toBeDefined();
    const hook = renderHook(() => useOMChatPane({ ...host.props, sample: false, available: true, open: true, toggle() {} }));
    expect(hook.result.current.pane.agents?.[0].models).toContainEqual(models[0]);
    await act(async () => { hook.result.current.pane.onSelectionChange?.({ agentId: 'om-model:acme-models', model: 'fixture-model' }); });
    expect(writes).toEqual([{ mode: 'model', provider: 'acme-models', model: 'fixture-model', connectionId: 'connection' }]);
    expect(hook.result.current.pane.selection?.agentId).toBe('om-model:acme-models');
    await act(async () => { hook.result.current.pane.onSelectionChange?.({ agentId: 'om-model:acme-models', model: 'unadvertised-model' }); });
    expect(writes).toHaveLength(1); hook.unmount();
  } finally { host.dispose(); }
});
it('owns renderer registrations per dock and unregisters them independently', () => {
  const first = testStudio(), second = testStudio();
  const one = renderHook(() => useOMChatPane({ ...first.props, sample: true, available: false, open: false, toggle() {} }));
  const two = renderHook(() => useOMChatPane({ ...second.props, sample: true, available: false, open: false, toggle() {} }));
  try {
    const firstRegistry = one.result.current.registry, secondRegistry = two.result.current.registry;
    expect(firstRegistry).not.toBe(secondRegistry); expect(firstRegistry.get({ name: 'om.approval' })).toBeDefined();
    one.unmount(); expect(firstRegistry.get({ name: 'om.approval' })).toBeUndefined();
    expect(secondRegistry.get({ name: 'om.approval' })).toBeDefined();
    two.unmount(); expect(secondRegistry.get({ name: 'om.surface' })).toBeUndefined();
  } finally { first.dispose(); second.dispose(); }
});
