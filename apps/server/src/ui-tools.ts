/** Jini component/page tools; transport is injected by server composition, policy by om-tools. */
import { z } from 'zod';
import { PAGE_CAPABILITIES, findCapabilityInputError } from '@jini-ai/agentic';
import { createA2uiInterpreter, createLabCatalog, flattenRenderTree } from '@jini-ai/agentic/a2ui';
import type { Catalog, ComponentInstance } from '@jini-ai/agentic/a2ui';
import { ALL_MANIFESTS } from '@jini-ai/ui/interactive-ui/manifests';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { boundedJsonSchema, idSchema, parseBoundary, surfaceAcknowledgementSchema, toolDescriptorSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, Outcome, SurfaceAcknowledgement } from '@open-marketing/contracts';
import type { OmToolDefinition } from './om-tool-types.js';
import { localFailure } from './composition/local-auth.js';

/** Host binds the current run to exactly one authenticated frontend; headless calls fail closed.
 * Implementations retain the run deadline/signal, recheck authority before delivery, and validate
 * response identity. They must never turn missing acknowledgements into rendered/completed.
 */
export interface UiFrontendPort {
    acknowledge(required: { context: CallContext; result: SurfaceAcknowledgement }): Promise<Outcome<void>>;
    page(required: { context: CallContext; name: string; input: unknown; signal?: AbortSignal }): Promise<Outcome<unknown>>;
    render(required: { context: CallContext; surfaceId: string; messages: readonly unknown[]; signal?: AbortSignal }): Promise<Outcome<SurfaceAcknowledgement>>;
}
const searchSchema = z.strictObject({ query: z.string().min(1).max(1024), limit: z.number().int().min(1).max(25).default(10) });
const describeSchema = z.strictObject({ id: idSchema });
const renderSchema = z.strictObject({ components: z.array(boundedJsonSchema).min(1).max(100) });

/** Headless catalog shares the published wire/props schemas with A2uiSurfaceCard, no React import.
 * @complexity O(c), fixed published catalog size; no global registry is created or modified.
 */
export function createUiCatalog(required: Record<string, never>): Catalog {
    const base = createLabCatalog(required);
    const components = new Map(base.components);
    for (const manifest of ALL_MANIFESTS) components.set(manifest.id, { kind: 'container', propsSchema: manifest.propsSchema });
    return { ...base, components };
}

/** Validate wire, props and expanded tree before sending anything to a browser.
 * @returns Bounded plain JSON messages or invalid_input; there are no browser effects here.
 * @complexity O(expanded nodes), Jini ceiling 50,000; accepted tree <=100 nodes/depth 16.
 */
export function prepareUiSurface(required: { input: unknown; surfaceId: string; clock: ClockPort; ids: IdPort }): Outcome<readonly unknown[]> {
    const parsed = parseBoundary({ schema: renderSchema, input: required.input });
    if (!parsed.ok) return parsed;
    const catalog = createUiCatalog({});
    const messages = [
        { version: 'v1.0', createSurface: { surfaceId: required.surfaceId, catalogId: catalog.catalogId, dataModel: {} } },
        { version: 'v1.0', updateComponents: { surfaceId: required.surfaceId, components: parsed.value.components } },
    ];
    if (!boundedJsonSchema.safeParse(messages).success) return localFailure({ code: 'limit_exceeded', message: 'Surface exceeds 64 KiB/depth 16' });
    const interpreter = createA2uiInterpreter({ catalog, clock: { nowMs: () => required.clock.now({}) }, ids: required.ids });
    for (const raw of messages) {
        const applied = interpreter.applyAgentMessage({ raw });
        if (applied.unattributedViolation || applied.rendererMessages.some(message => 'error' in message))
            return localFailure({ code: 'invalid_input', message: 'Jini rejected the surface wire, component or props' });
    }
    return checkedSurfaceTree({ interpreter, surfaceId: required.surfaceId, componentCount: parsed.value.components.length, messages });
}

/** Reject missing/cyclic references and expansion beyond the declared rendering bounds. */
function checkedSurfaceTree(required: { interpreter: ReturnType<typeof createA2uiInterpreter>; surfaceId: string; componentCount: number; messages: readonly unknown[] }): Outcome<readonly unknown[]> {
    const { interpreter } = required;
    const surface = interpreter.getSurface({ surfaceId: required.surfaceId });
    if (!surface || !interpreter.getRoot({ surfaceId: required.surfaceId })) return localFailure({ code: 'invalid_input', message: 'Surface must contain a root component' });
    if (surface.components.size !== required.componentCount) return localFailure({ code: 'invalid_input', message: 'Duplicate component IDs are not allowed' });
    const nodes = flattenRenderTree({ components: surface.components, rootId: 'root', getChildIds: componentChildren });
    if (nodes.length > 100 || nodes.some(node => node.depth > 16 || node.status !== 'ok'))
        return localFailure({ code: 'invalid_input', message: 'Surface has missing/cyclic children or exceeds 100 rendered nodes/depth 16' });
    return { ok: true, value: required.messages };
}
function componentChildren(required: { component: ComponentInstance }): readonly string[] {
    const { children, child } = required.component.props;
    if (Array.isArray(children)) return children.filter((value): value is string => typeof value === 'string');
    return typeof child === 'string' ? [child] : [];
}

/** Display-envelope boundary shared by owner acknowledgement routes and render tool adapters. */
export function checkedSurfaceAcknowledgement(required: { input: unknown; surfaceId: string; runId: string }): Outcome<SurfaceAcknowledgement> {
    const parsed = parseBoundary({ schema: surfaceAcknowledgementSchema, input: required.input });
    if (!parsed.ok) return parsed;
    if (parsed.value.surfaceId !== required.surfaceId || parsed.value.runId !== required.runId)
        return localFailure({ code: 'protocol_mismatch', message: 'Different surface/run acknowledged' });
    return parsed;
}

/** Plain definitions go through the existing generic OM dispatcher, including local page writes.
 * Missing frontend transport advertises NEEDS; it never fabricates browser completion.
 * @example buildUiToolDefinitions({ runtime: { clock, ids }, frontend });
 * @complexity Fixed catalog/page count; searches <=25 results and inputs <=64 KiB.
 */
export function buildUiToolDefinitions(required: { runtime: { clock: ClockPort; ids: IdPort } | null; frontend?: UiFrontendPort }): readonly OmToolDefinition[] {
    const catalog = createUiCatalog({});
    const definition = (input: { name: string; description: string; schema: z.ZodType; policy: 'read' | 'write'; invoke: OmToolDefinition['invoke']; frontend?: true }): OmToolDefinition => ({
        name: input.name, capability: input.description, description: input.description, revision: 'a5-1', effects: [input.policy], policy: input.policy,
        inputSchema: toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(input.schema, { io: 'input' })),
        unavailableReason: input.frontend && (!required.frontend || !required.runtime) ? 'NEEDS A5 composition: no authenticated frontend-session transport' : undefined,
        parse: value => parseBoundary({ schema: input.schema, input: value.input }), invoke: input.invoke,
    });
    return [
        definition({ name: 'search_components', description: 'Find Jini A2UI components and neutral chart wire IDs; describe_component gives their exact props.', schema: searchSchema, policy: 'read',
            invoke: async input => {
                const query = searchSchema.parse(input.input);
                return { ok: true, value: [...catalog.components.keys()].map(id => componentSummary({ id }))
                    .filter(item => JSON.stringify(item).toLowerCase().includes(query.query.toLowerCase())).slice(0, query.limit) };
            } }),
        definition({ name: 'describe_component', description: 'Read the exact Jini component props schema before composing a render surface.', schema: describeSchema, policy: 'read',
            invoke: async input => {
                const { id } = describeSchema.parse(input.input);
                const component = catalog.components.get(id);
                if (!component) return localFailure({ code: 'invalid_input', message: 'Component is not in the Jini catalog' });
                // SDK handles Jini's Zod 3 schema. The opaque cast avoids recursive comparison of
                // independent Zod installs; only converted plain JSON crosses into OM's Zod 4.
                const propsSchema = toJsonSchemaCompat(component.propsSchema as unknown as Parameters<typeof toJsonSchemaCompat>[0]);
                return parseBoundary({ schema: boundedJsonSchema, input: { ...componentSummary({ id }), propsSchema } });
            } }),
        definition({ name: 'render', description: 'Render an A2UI v1.0 flat components array with one root. Charts use chart plugins, falling back to a table. Completion requires browser acknowledgement.', schema: renderSchema, policy: 'write', frontend: true,
            invoke: async input => {
                if (!required.frontend || !required.runtime || !input.context.runId) return localFailure({ code: 'unavailable', message: 'No live frontend is bound to this run' });
                const surfaceId = required.runtime.ids.next({});
                const messages = prepareUiSurface({ ...required.runtime, input: input.input, surfaceId });
                if (!messages.ok) return messages;
                const result = await required.frontend.render({ ...input, surfaceId, messages: messages.value });
                if (!result.ok) return result;
                return checkedSurfaceAcknowledgement({ input: result.value, surfaceId, runId: input.context.runId ?? '' });
            } }),
        ...PAGE_CAPABILITIES.map(capability => ({ name: capability.id, capability: capability.description, description: capability.description,
            revision: 'a5-1', effects: [capability.risk], policy: capability.risk,
            inputSchema: toolDescriptorSchema.shape.inputSchema.parse(capability.inputSchema),
            unavailableReason: !required.frontend ? 'NEEDS A5 composition: no authenticated frontend-session transport' : undefined,
            parse: (input: { input: unknown }) => checkedPageInput({ capability, input: input.input }),
            invoke: async (input: Parameters<OmToolDefinition['invoke']>[0]) => required.frontend
                ? required.frontend.page({ ...input, name: capability.id }) : localFailure({ code: 'unavailable', message: 'No live frontend is bound to this run' }),
        })),
    ];
}
function componentSummary(required: { id: string }) {
    const manifest = ALL_MANIFESTS.find(item => item.id === required.id);
    return { id: required.id, provider: manifest?.provider ?? 'a2ui.basic', capabilities: manifest?.capabilities ?? [required.id.toLowerCase()], description: manifest?.description ?? required.id };
}
function checkedPageInput(required: { capability: (typeof PAGE_CAPABILITIES)[number]; input: unknown }): Outcome<unknown> {
    const parsed = parseBoundary({ schema: z.record(z.string(), boundedJsonSchema), input: required.input });
    if (!parsed.ok) return parsed;
    const error = findCapabilityInputError({ capability: required.capability, input: parsed.value });
    return error ? localFailure({ code: 'invalid_input', message: error }) : parsed;
}
