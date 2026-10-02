import type { ServiceControlCredential } from "@open-marketing/contracts";
import type { HttpRequest, HttpListenerPort, LifecyclePort, JiniRuntimePort } from "../ports.js";
import { handleControl, type ControlAuthPort } from "../inbound/control.js";
/** Sole agent composition root. Neither imports nor factory invokes listener/runtime. j22 supplies a verified runtime. */
export function createAgentApp(required: { listener: HttpListenerPort; runtime: JiniRuntimePort; auth: ControlAuthPort; credential: ServiceControlCredential }): LifecyclePort {
 return { start: () => required.listener.start({ handle: (request: HttpRequest) => handleControl({ request, auth: required.auth, credential: required.credential, runtime: required.runtime }) }), stop: () => required.listener.stop({}) };
}
