/** Browser binding only: Jini owns execution, frontend attachment and invocation deduplication. */
import { z } from 'zod';
import { a2uiSurfacePayloadSchema, boundedJsonSchema, idSchema } from '@open-marketing/contracts';
import { createDomPageDriver } from '@jini-ai/agentic/dom';
import type { DomPageDriverRequired } from '@jini-ai/agentic/dom';
import { PAGE_CAPABILITIES, resolveHandleSelector } from '@jini-ai/agentic';
import type { PageDriver } from '@jini-ai/agentic';
import { createBrowserPageActions } from '@jini-ai/chat/browser/page-actions';
import type { BrowserPageActionsArgs } from '@jini-ai/chat/browser/page-actions';
import { createFrontendSessionBridge } from '@jini-ai/chat/react';
import type { FrontendSessionBridge, FrontendSessionBridgeArgs } from '@jini-ai/chat/react';
import type { StudioRuntime } from '../../../shared/api/index.js';

/** Only host-declared local controls may write through DOM. Business operations use the OM
 * catalog; approval cards, credentials and generated/user content are outside this root.
 * @example createStudioPageDriver({ dom, browser, runtime, currentRun, localWriteHandles });
 * @complexity O(tagged controls), Jini owns bounds; handles are resolved, never caller selectors.
 */
export function createStudioPageDriver(required: {
    dom: DomPageDriverRequired; browser: BrowserPageActionsArgs; runtime: StudioRuntime;
    currentRun(): { runId: string; expiresAt: number } | null;
    localWriteHandles: ReadonlySet<string>;
}): { driver: PageDriver; dispose(): void } {
    const driver = createDomPageDriver(required.dom);
    const actions = createBrowserPageActions(required.browser);
    let disposed = false;
    function admitted(input: { handle?: string; write?: true }): void {
        const run = required.currentRun();
        if (disposed || !run || run.expiresAt <= required.runtime.clock.now({})) throw new Error('No live run is bound to this page');
        if (input.write && (!input.handle || !required.localWriteHandles.has(input.handle)))
            throw new Error('Use the OM catalog for this business action');
        if (!input.handle) return;
        const selector = resolveHandleSelector({ handle: input.handle });
        const element = required.dom.root.querySelector(selector);
        if (!element || element.closest('[data-agent-private], #om-chat, .approval-card, [data-a2ui-surface-id]'))
            throw new Error('Control is unavailable to the page driver');
    }
    return { driver: {
        ...driver,
        async findElements(input, options) { admitted({}); return driver.findElements(input, options); },
        async listPages(input, options) { admitted({}); return driver.listPages(input, options); },
        async describeField(input) { admitted(input); return driver.describeField(input); },
        async describeState(input) { admitted(input); return driver.describeState?.(input) ?? null; },
        async highlight(input) { admitted(input); actions.applyHighlight({ element: elementFor({ root: required.dom.root, handle: input.handle }) }); },
        async scrollTo(input) { admitted(input); actions.scrollToElement({ element: elementFor({ root: required.dom.root, handle: input.handle }) }); },
        async navigate(input) { admitted({}); await driver.navigate(input); },
        async click(input) { admitted({ ...input, write: true }); await driver.click(input); },
        async fill(input) { admitted({ ...input, write: true }); await driver.fill(input); },
        async selectOption(input, options) { admitted({ ...input, write: true }); await driver.selectOption(input, options); },
    }, dispose() { disposed = true; actions.clearHighlight({}); } };
}
function elementFor(required: { root: DomPageDriverRequired['root']; handle: string }): Element {
    const selector = resolveHandleSelector({ handle: required.handle });
    const element = required.root.querySelector(selector);
    if (!element) throw new Error('Page control disappeared');
    return element;
}

/** Jini retains executed invocation IDs and closes the frontend attachment on disposal.
 * Transport must bind authenticated session/run identity before releasing invocation frames.
 * Read the current session ID at run-start; reconnects replace it. No local executor is added.
 */
export function bindPageActions(required: {
    driver: PageDriver; transport: FrontendSessionBridgeArgs;
    currentRun(): { runId: string; expiresAt: number; frontendSessionId?: string } | null;
    onBound(required: { runId: string; expiresAt: number; frontendSessionId: string }): void;
    onVoided(required: { runId: string; status: 'cancelled' | 'interrupted' }): void;
    onSurface(required: { input: unknown }): void;
    onError(required: { error: unknown }): void;
}): FrontendSessionBridge & { sessionId(): string | undefined } {
    let sessionId: string | undefined;
    const transport = { ...required.transport, openStream: (input: { url: string }) => {
        // Jini uses repeated capability fields; OM's HTTP boundary accepts unique fields only.
        const url = new URL(input.url, 'http://om.invalid');
        const capabilities = url.searchParams.getAll('capability').filter(id => PAGE_CAPABILITIES.some(capability => capability.id === id));
        url.searchParams.delete('capability'); url.searchParams.set('capabilities', capabilities.join(','));
        const source = required.transport.openStream({ url: url.pathname + url.search });
        source.addEventListener('message', event => {
            try {
                const frame: unknown = JSON.parse(event.data);
                const accepted = checkedFrontendFrame({ input: frame, sessionId, run: required.currentRun() });
                if (!accepted.ok) { event.stopImmediatePropagation(); required.onError({ error: new Error(accepted.reason) }); return; }
                if (accepted.type === 'attached') sessionId = accepted.sessionId;
                if (accepted.type === 'bound') required.onBound(accepted.binding);
                if (accepted.type === 'voided') required.onVoided(accepted.binding);
                if (accepted.type === 'surface') required.onSurface({ input: frame });
            } catch { event.stopImmediatePropagation(); required.onError({ error: new Error('Invalid frontend frame') }); }
        });
        source.addEventListener('error', () => { sessionId = undefined; });
        return source;
    } };
    const bridge = createFrontendSessionBridge(transport, { pageDriver: required.driver,
        onError: error => required.onError({ error }) });
    void bridge.ready.catch(error => required.onError({ error }));
    return { ...bridge, sessionId: () => bridge.bindToken() ? sessionId : undefined,
        close() { sessionId = undefined; bridge.close(); } };
}

/** Parse frames before Jini executes them. Reconnect and foreign run/session frames cannot drive UI.
 * @complexity O(frame bytes), bounded to 64 KiB JSON; no browser effects.
 */
export function checkedFrontendFrame(required: { input: unknown; sessionId?: string; run: { runId: string; frontendSessionId?: string } | null }): FrontendFrame {
    const control = frontendControlSchema.safeParse(required.input);
    if (control.success) return checkedFrontendControl({ control: control.data, sessionId: required.sessionId });
    const surface = a2uiSurfacePayloadSchema.safeParse(required.input);
    const invocation = z.strictObject({ type: z.literal('invocation'), invocationId: idSchema, capabilityId: idSchema, runId: idSchema, frontendSessionId: idSchema, input: boundedJsonSchema }).safeParse(required.input);
    const parsed = surface.success ? surface.data : invocation.success ? invocation.data : null;
    if (!matchesFrontendRun({ frame: parsed, sessionId: required.sessionId, run: required.run }))
        return { ok: false, reason: 'Frontend frame belongs to another run/session' };
    if (invocation.success && !PAGE_CAPABILITIES.some(capability => capability.id === invocation.data.capabilityId))
        return { ok: false, reason: 'Unsupported frontend capability' };
    return { ok: true, type: surface.success ? 'surface' : 'invocation' };
}
type FrontendFrame = { ok: true; type: 'attached'; sessionId: string }
    | { ok: true; type: 'bound'; binding: { runId: string; expiresAt: number; frontendSessionId: string } }
    | { ok: true; type: 'voided'; binding: { runId: string; status: 'cancelled' | 'interrupted' } }
    | { ok: true; type: 'surface' | 'invocation' } | { ok: false; reason: string };
const frontendControlSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('attached'), sessionId: idSchema, bindToken: z.string().min(1).max(8192) }),
    z.strictObject({ type: z.literal('bound'), runId: idSchema, expiresAt: z.number().int().nonnegative(), frontendSessionId: idSchema }),
    z.strictObject({ type: z.literal('voided'), runId: idSchema, frontendSessionId: idSchema, status: z.enum(['cancelled', 'interrupted']) }),
]);
/** Control frames must refer to this attachment; the session owns the run-start/terminal state. */
function checkedFrontendControl(required: { control: z.infer<typeof frontendControlSchema>; sessionId?: string }): FrontendFrame {
    const control = required.control;
    if (control.type === 'attached') return { ok: true, type: 'attached', sessionId: control.sessionId };
    if (control.frontendSessionId !== required.sessionId) return { ok: false, reason: 'Frontend control belongs to another attachment' };
    return control.type === 'bound' ? { ok: true, type: 'bound', binding: control } : { ok: true, type: 'voided', binding: control };
}
/** Invocation/surface identity is independent of Jini's component or page argument schemas. */
function matchesFrontendRun(required: { frame: { runId: string; frontendSessionId: string } | null; sessionId?: string; run: { runId: string; frontendSessionId?: string } | null }): boolean {
    return required.frame !== null && required.run !== null && required.frame.runId === required.run.runId
        && required.frame.frontendSessionId === required.sessionId && required.frame.frontendSessionId === required.run.frontendSessionId;
}
