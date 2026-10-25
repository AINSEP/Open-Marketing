/** Chart snapshot and actual browser acknowledgements; A2uiSurfaceCard owns interpretation. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { parseRendererToAgentMessage } from '@jini-ai/agentic/a2ui';
import { DEFAULT_INTERACTIVE_UI_REGISTRY, InteractiveUiRegistry } from '@jini-ai/ui/interactive-ui';
import { createChartProviderRegistry } from '@jini-ai/ui/charts';
import type { ChartProviderRegistry } from '@jini-ai/ui/charts';
import type { A2uiAgentActionOutcome, A2uiSurfaceCardProps } from '@jini-ai/chat/react';
import { a2uiSurfacePayloadSchema, toolCallSchema } from '@open-marketing/contracts';
import type { A2uiSurfacePayload, ConfirmationCard, SurfaceAcknowledgement, ToolResult } from '@open-marketing/contracts';
import { createChartInteractiveRegistry } from '@jini-ai/ui/charts/react';
import type { StudioApiPort, StudioRuntime } from '../../shared/api/index.js';

export interface A2uiSurfaceProps {
    surface: A2uiSurfacePayload; api: StudioApiPort; runtime: StudioRuntime;
    streaming: boolean; succeeded: boolean;
    /** Chat owns one provider snapshot shared by all mounted surfaces. */
    providers?: ChartProviderRegistry;
    onPendingApproval?(required: { runId: string; card: ConfirmationCard }): void;
}

/** Read actual renderer DOM: placeholders/refusals never acknowledge a rendered surface. */
export function surfaceRenderStatus(required: { root: HTMLElement | null; surfaceId: string }): 'waiting' | 'rendered' | 'failed' {
    if (!required.root) return 'waiting';
    if (required.root.querySelector('.a2ui-placeholder, .a2ui-surface-refused, .a2ui-surface-notice-refused')) return 'failed';
    const card = required.root.querySelector('[data-a2ui-surface-id]');
    return card?.getAttribute('data-a2ui-surface-id') === required.surfaceId ? 'rendered' : 'waiting';
}

/** Surface actions name catalog tools; the existing server dispatcher supplies their policy.
 * Foreign two-positional-argument callback is wrapped by the hook below.
 * @complexity O(message bytes), <=64 KiB; one write request, no automatic retry.
 */
export async function dispatchSurfaceAction(required: { props: A2uiSurfaceProps; runId: string | undefined; message: unknown }): Promise<A2uiAgentActionOutcome> {
    if (!required.props.streaming && !required.props.succeeded) return { ok: false, reason: 'This run is no longer available for surface actions' };
    if (required.runId !== required.props.surface.runId) return { ok: false, reason: 'Surface run mismatch' };
    const parsed = parseRendererToAgentMessage({ raw: required.message });
    if (!parsed.ok || !('action' in parsed.message)) return { ok: false, reason: 'Unsupported surface action' };
    const action = parsed.message.action;
    if (action.surfaceId !== required.props.surface.surfaceId || !required.props.api.tool) return { ok: false, reason: 'Surface tool transport unavailable' };
    const call = toolCallSchema.safeParse({ name: action.name, input: action.context, operationId: required.props.runtime.ids.next({}) });
    if (!call.success) return { ok: false, reason: 'Invalid surface tool call' };
    const result = await required.props.api.tool({ call: call.data, runId: required.props.surface.runId, frontendSessionId: required.props.surface.frontendSessionId });
    if (!result.ok) return { ok: false, reason: result.error.message };
    if (result.value.status === 'completed') return { ok: true };
    return showSurfaceApproval({ props: required.props, result: result.value });
}

/** Fetch the exact server card and insert it into A2's existing inline card list. */
async function showSurfaceApproval(required: { props: A2uiSurfaceProps; result: Extract<ToolResult, { status: 'pending' }> }): Promise<A2uiAgentActionOutcome> {
    const result = required.result;
    if (result.cardId && required.props.api.approvalCard) {
        const card = await required.props.api.approvalCard({ cardId: result.cardId });
        if (!card.ok) return { ok: false, reason: card.error.message };
        if (card.value.cardId !== result.cardId || card.value.operationId !== result.operationId)
            return { ok: false, reason: 'Surface approval card identity mismatch' };
        required.props.onPendingApproval?.({ runId: required.props.surface.runId, card: card.value });
    }
    return { ok: false, reason: 'Owner approval is pending for operation ' + result.operationId + '. The action has not completed.' };
}

/** Immutable chart registry shared with Jini validation/rendering; empty registry uses tables.
 * Ack polling lasts <=5 seconds with injected timers; disposal cancels observation.
 * @example const model = useA2uiSurface({ props, providers });
 * @complexity O(catalog entries); one bounded acknowledgement sequence per mounted surface.
 */
export function useA2uiSurface(required: { props: A2uiSurfaceProps; providers?: ChartProviderRegistry }): {
    root: RefObject<HTMLDivElement | null>; registry: InteractiveUiRegistry;
    onAgentAction: NonNullable<A2uiSurfaceCardProps['onAgentAction']>;
    notice: string; cardKey: number;
} {
    const root = useRef<HTMLDivElement>(null);
    const [notice, setNotice] = useState('');
    const fallback = useMemo(() => createChartProviderRegistry({ providers: [] }), []);
    const registry = useMemo(() => createChartInteractiveRegistry({
        registry: new InteractiveUiRegistry({ entries: DEFAULT_INTERACTIVE_UI_REGISTRY.list() }), providers: required.providers ?? fallback,
    }), [required.providers, fallback]);
    const revision = useRef(0);
    const acknowledgedInvocation = useRef<string | null>(null);
    const cardKey = useMemo(() => ++revision.current, [registry]);
    const surface = required.props.surface;
    useEffect(() => {
        if (acknowledgedInvocation.current === surface.invocationId) return;
        const controller = required.props.runtime.abort();
        const report = async ({ status }: { status: SurfaceAcknowledgement['status'] }) => {
            if (!required.props.api.acknowledgeSurface || controller.signal.aborted) return;
            const identity = { surfaceId: surface.surfaceId, invocationId: surface.invocationId, runId: surface.runId, frontendSessionId: surface.frontendSessionId };
            const result: SurfaceAcknowledgement = status === 'failed'
                ? { ...identity, status, error: { code: 'invalid_input', message: 'Browser renderer refused or did not mount the surface', retryable: false } }
                : { ...identity, status };
            const acknowledged = await required.props.api.acknowledgeSurface({ result });
            if (acknowledged.ok && status !== 'sent') acknowledgedInvocation.current = surface.invocationId;
            if (!acknowledged.ok && !controller.signal.aborted) setNotice('Browser acknowledgement could not reach the server.');
        };
        const observe = async () => {
            if (!a2uiSurfacePayloadSchema.safeParse(surface).success) { await report({ status: 'failed' }); return; }
            await report({ status: 'sent' });
            const deadline = required.props.runtime.clock.now({}) + 5000;
            while (!controller.signal.aborted && required.props.runtime.clock.now({}) < deadline) {
                const status = surfaceRenderStatus({ root: root.current, surfaceId: surface.surfaceId });
                if (status !== 'waiting') { await report({ status }); return; }
                await required.props.runtime.timers.wait({ delayMs: 50, signal: controller.signal });
            }
            if (!controller.signal.aborted) await report({ status: 'failed' });
        };
        void observe().catch(() => { if (!controller.signal.aborted) setNotice('Surface observation interrupted.'); });
        return () => controller.abort();
    }, [surface, required.props.api, required.props.runtime, registry]);
    const onAgentAction = useMemo<NonNullable<A2uiSurfaceCardProps['onAgentAction']>>(() => (runId, message) =>
        dispatchSurfaceAction({ props: required.props, runId, message }), [required.props.api, required.props.runtime, required.props.streaming, required.props.succeeded, required.props.onPendingApproval, surface]);
    return { root, registry, onAgentAction, notice, cardKey };
}
