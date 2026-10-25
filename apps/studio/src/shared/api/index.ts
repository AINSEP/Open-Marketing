/** Public presentation boundary; domain work remains behind the server API. */
export { createEventClient } from "./events.js";
export type { JsonTransportPort, SseTransportPort, EventClient, StreamInput } from "./events.js";
export { createSampleStudioApi } from "./sample.js";
export { createHttpStudioApi } from "./http.js";
export { parseStudioSnapshot, parseStudioEvent, isSafeUiValue } from "./validation.js";
export type { StudioApiPort, StudioSnapshot, StudioRow, StudioMetric, StudioRun, StudioPayload, StudioRuntime, TimerPort } from "./types.js";

export { oauthClientSetSchema, oauthChallengeSchema } from "./validation.js";
export type { OAuthPlugin, OAuthClientRequest, OAuthClientStatus, OAuthStatus } from "./validation.js";
