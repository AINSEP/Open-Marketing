/** Local best-effort telemetry. No SDK, provider configuration, queue, or module state. */
import { approvalResponseSchema, captureEventSchema } from '@open-marketing/contracts';
import type { ApprovalResponse, Outcome } from '@open-marketing/contracts';
import type { ObservabilityPort } from '@jini-ai/diagnostics/observability';
import type { StudioApiPort, StudioRuntime, StudioTrace, StudioTrack } from './types.js';

/** Diagnostic dependencies may throw; they must never replace or repeat application work. */
function attempt<T>(required: { run(): T }): T | undefined { try { return required.run(); } catch { return undefined; } }

/** Decorate the existing API once; inject the bound track function through its runtime.
 * The temporary click context is consumed synchronously by approve, before any await.
 * @example const { api, runtime } = instrumentStudioApi({ api: raw, runtime: host, observability });
 * @complexity O(m) construction for the fixed API methods; O(1) per call, <=4 captures in flight.
 */
export function instrumentStudioApi(required: { api: StudioApiPort; runtime: StudioRuntime; observability: ObservabilityPort }): { api: StudioApiPort; runtime: StudioRuntime & { readonly track: StudioTrack } } {
  let inFlight = 0;
  let click: { cardId: string; operationId: string; choice: string; trace: StudioTrace } | undefined;
  const nextTrace = (): StudioTrace | undefined => attempt({ run: () => ({ correlationId: required.runtime.ids.next({}), traceId: required.runtime.ids.next({}) }) });
  const release = (): void => { inFlight--; };
  /** Strict validation owns privacy and size; diagnostic endpoints bypass their own decorator. */
  const capture = (input: { event: unknown }): void => {
    attempt({ run: () => {
      const event = captureEventSchema.safeParse(input.event);
      if (!event.success || event.data.kind === 'trace' || !required.api.captureEvent || inFlight >= 4) return;
      const result = required.api.captureEvent({ event: event.data });
      inFlight++;
      void Promise.resolve(result).then(release, release);
    } });
  };
  const track: StudioTrack = ({ name }, { properties }) => {
    attempt({ run: () => {
      const trace = name === 'approval.clicked' ? nextTrace() : undefined;
      const kind = ['approval.invalid_card', 'approval.submit_failed', 'studio.render_crash'].includes(name) ? 'error' : 'product';
      const event = captureEventSchema.safeParse({ ...properties, ...trace, name, kind, at: required.runtime.clock.now({}) });
      if (!event.success) return;
      if (event.data.name === 'approval.clicked') click = { cardId: event.data.cardId, operationId: event.data.operationId, choice: event.data.choice,
        trace: { correlationId: event.data.correlationId, traceId: event.data.traceId } };
      capture({ event: event.data });
    } });
  };
  /** Matches Jini's coming reportError shape; only fixed codes and validated identifiers cross it. */
  const reportError = (input: { error: string; context: { name: string; trace?: StudioTrace; response?: ApprovalResponse } }): void => {
    const { context } = input;
    const response = context.response;
    if (context.name !== 'approve' || !response) return;
    attempt({ run: () => capture({ event: { kind: 'error', name: 'approval.submit_failed', at: required.runtime.clock.now({}),
      cardId: response.cardId, operationId: response.operationId,
      correlationId: context.trace?.correlationId, traceId: context.trace?.traceId, errorCode: input.error } }) });
  };
  /** Mirrors trackOperation({ name, attributes }) -> end({ outcome, failed }); first end wins. */
  const trackOperation = (input: { name: string; attributes: { trace?: StudioTrace; response?: ApprovalResponse; signal?: AbortSignal } }) => {
    const tracker = attempt({ run: () => required.observability.trackRequest({ method: 'API', path: 'api.' + input.name }, { requestId: input.attributes.trace?.correlationId }) });
    let ended = false;
    const end = (result: { outcome: string; failed: boolean }): void => {
      if (ended) return;
      ended = true;
      attempt({ run: () => input.attributes.signal?.removeEventListener('abort', aborted) });
      attempt({ run: () => tracker?.end({ statusCode: result.failed ? 500 : 200, routePattern: 'api.' + input.name }) });
      if (result.failed) reportError({ error: result.outcome, context: { name: input.name, trace: input.attributes.trace, response: input.attributes.response } });
    };
    const aborted = (): void => end({ outcome: input.attributes.signal?.reason === 'timeout' ? 'timeout' : 'cancelled', failed: true });
    attempt({ run: () => input.attributes.signal?.addEventListener('abort', aborted, { once: true }) });
    return { end };
  };
  /** Preserve receiver, arguments and outcomes; only approve consumes the immediately preceding click. */
  const wrapMethod = (input: { name: string; owner: object; method: CallableFunction }) => (args: { signal?: AbortSignal; response?: unknown }) => {
    const response = input.name === 'approve' ? attempt({ run: () => approvalResponseSchema.safeParse(args.response) }) : undefined;
    const card = response?.success ? response.data : undefined;
    const accepted = input.name === 'approve' ? click : undefined;
    if (input.name === 'approve') click = undefined;
    const matches = card && accepted && card.cardId === accepted.cardId && card.operationId === accepted.operationId && card.choice === accepted.choice;
    const trace = matches ? accepted.trace : nextTrace();
    const operation = trackOperation({ name: input.name, attributes: { trace, response: card, signal: args.signal } });
    const call = () => Reflect.apply(input.method, input.owner, [{ ...args, trace }]) as Promise<Outcome<unknown>>;
    if (input.name === 'events') return observedStream({ call: () => Reflect.apply(input.method, input.owner, [{ ...args, trace }]), end: operation.end });
    return observedCall({ call, end: operation.end });
  };
  const wrap = (input: { owner: object; prefix: string }): object => Object.fromEntries(Object.entries(input.owner).map(([name, method]) =>
    [name, typeof method === 'function' && name !== 'captureEvent' && name !== 'recentEvents' ? wrapMethod({ name: input.prefix + name, owner: input.owner, method }) : method]));
  const api = wrap({ owner: required.api, prefix: '' }) as StudioApiPort;
  return { api: { ...api, addons: required.api.addons ? wrap({ owner: required.api.addons, prefix: 'addons.' }) as StudioApiPort['addons'] : undefined },
    runtime: { ...required.runtime, track } };
}

type Completion = (required: { outcome: string; failed: boolean }) => void;
/** Call exactly once. Opaque adapter exceptions are reported safely and retain their original behavior. */
async function observedCall(required: { call(): Promise<Outcome<unknown>>; end: Completion }): Promise<Outcome<unknown>> {
  try { const result = await required.call(); required.end({ outcome: result.ok ? 'recorded' : result.error.code, failed: !result.ok }); return result; }
  catch (error) { required.end({ outcome: 'unavailable', failed: true }); throw error; }
}
/** Streaming outcomes retain their ABI; first failure or terminal completion closes one tracker. */
async function* observedStream(required: { call(): AsyncIterable<Outcome<unknown>>; end: Completion }) {
  try { for await (const result of required.call()) { if (!result.ok) required.end({ outcome: result.error.code, failed: true }); yield result; } }
  catch (error) { required.end({ outcome: 'unavailable', failed: true }); throw error; }
  finally { required.end({ outcome: 'recorded', failed: false }); }
}
