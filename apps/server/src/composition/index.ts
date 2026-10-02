import type { ClockPort } from "@open-marketing/contracts";
import type { HttpRequest, HttpListenerPort, LifecyclePort } from "../ports.js";
import { handleOmRequest, type RunGrantVerifierPort } from "../inbound/om.js";
/** Sole server composition root. DB/workers remain unimplemented; this process never owns an agent executor. */
export function createServerApp(required: { listener: HttpListenerPort; grants: RunGrantVerifierPort; clock: ClockPort }): LifecyclePort {
 return { start: () => required.listener.start({ handle: (request: HttpRequest) => handleOmRequest({ request, grants: required.grants, clock: required.clock }) }), stop: () => required.listener.stop({}) };
}
