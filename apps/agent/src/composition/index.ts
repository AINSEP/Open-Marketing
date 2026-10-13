import type { ServiceControlCredential } from "@open-marketing/contracts";
import type { HttpRequest, HttpListenerPort, LifecyclePort, JiniRuntimePort } from "../ports.js";
import { handleControl, type ControlAuthPort } from "../inbound/control.js";
/** Sole inert agent composition. Sandbox boot opts into actual readiness; other runtimes default unavailable. */
export function createAgentApp(required: { listener: HttpListenerPort; runtime: JiniRuntimePort; auth: ControlAuthPort; credential: ServiceControlCredential; runtimeAvailable?: boolean }): LifecyclePort {
 return { start: () => required.listener.start({ handle: (request: HttpRequest) => handleControl({ request, auth: required.auth, credential: required.credential, runtime: required.runtime, runtimeAvailable: required.runtimeAvailable }) }), stop: () => required.listener.stop({}) };
}
