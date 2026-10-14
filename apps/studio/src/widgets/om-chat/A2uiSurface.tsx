import { A2uiSurfaceCard } from '@jini-ai/chat/react';
import { useA2uiSurface } from './A2uiSurface.hooks.js';
import type { A2uiSurfaceProps } from './A2uiSurface.hooks.js';

/** Thin published renderer wrapper. Charts stay plugin-provided, with Jini's table fallback. */
export function A2uiSurface(props: A2uiSurfaceProps) {
    const model = useA2uiSurface({ props, providers: props.providers });
    return <SurfaceCard props={props} model={model} />;
}
function SurfaceCard(required: { props: A2uiSurfaceProps; model: ReturnType<typeof useA2uiSurface> }) {
    return <div ref={required.model.root} data-agent-private>
        <A2uiSurfaceCard key={required.model.cardKey} name="a2ui" events={required.props.surface.messages} runId={required.props.surface.runId}
            runStreaming={required.props.streaming} runSucceeded={required.props.succeeded}
            registry={required.model.registry} onAgentAction={required.model.onAgentAction} />
        {required.model.notice && <p role="status">{required.model.notice}</p>}
    </div>;
}
