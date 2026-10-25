import { A2uiSurfaceCard } from '@jini-ai/chat/react';
import { useA2uiSurface } from './A2uiSurface.hooks.js';
import type { A2uiSurfaceProps } from './A2uiSurface.hooks.js';

/** Thin published renderer wrapper. Charts stay plugin-provided, with Jini's table fallback. */
export function A2uiSurface(props: A2uiSurfaceProps) {
    const model = useA2uiSurface({ props, providers: props.providers });
    return <div ref={model.root} data-agent-private>
        <A2uiSurfaceCard key={model.cardKey} name="a2ui" events={props.surface.messages} runId={props.surface.runId}
            runStreaming={props.streaming} runSucceeded={props.succeeded}
            registry={model.registry} onAgentAction={model.onAgentAction} />
        {model.notice && <p role="status">{model.notice}</p>}
    </div>;
}
