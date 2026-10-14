import type { CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import { invokeMetaInstagram } from "../src/index.js";
import type { MetaInstagramDispatch, MetaInstagramPost, MetaInstagramRequest, MetaInstagramWait } from "../src/index.js";
import { failure } from "../src/boundary.js";
import { context, now } from "./fixtures.js";

export const configuration = { apiVersion: "v25.0", timeoutMs: 15000 };
export const image: MetaInstagramPost = { kind: "image", igUserId: "123", caption: "A fixture #launch", imageUrl: "https://media.example.com/photo.jpg" };
export const resume: MetaInstagramPost = { kind: "resume", igUserId: "123", caption: image.caption, containerId: "201" };
type DispatchInput = Parameters<MetaInstagramDispatch>[0];
type Mode = "ok" | "timeout" | "refused" | "malformed";
export interface InstagramFixture {
  dispatch: MetaInstagramDispatch; clock: ClockPort; wait: MetaInstagramWait; observer: ObserverPort;
  calls: DispatchInput[]; options: (CallOptions | undefined)[]; waits: number[];
  observations: Parameters<ObserverPort["observe"]>[0][];
  state: { now: number; current: boolean; published: boolean; containerStatus: string; quotaUsage: number; quotaTotal: number; creations: number };
}

/** Fresh credential-free double for each case. Fabricated responses are not vendor verification.
 * The production server adapter runs the same four-case suite with a fake HTTP transport.
 */
export function instagramFixture(required: { mode?: Mode; handler?: (required: DispatchInput) => Outcome<unknown> | undefined } = {}): InstagramFixture {
  const calls: DispatchInput[] = [];
  const options: (CallOptions | undefined)[] = [];
  const waits: number[] = [];
  const observations: InstagramFixture["observations"] = [];
  const state: InstagramFixture["state"] = { now, current: required.mode !== "refused", published: false, containerStatus: "FINISHED", quotaUsage: 0, quotaTotal: 50, creations: 0 };
  const dispatch: MetaInstagramDispatch = async (input, optional) => {
    if (!state.current) return failure({ code: "forbidden", message: "Fixture authority refused after credential resolution" });
    calls.push(input); options.push(optional);
    const override = required.handler?.(input);
    if (override !== undefined) return override;
    return fixtureResponse({ input, state, mode: required.mode ?? "ok" });
  };
  return { dispatch, calls, options, waits, observations, state,
    clock: { now: () => state.now },
    wait: async input => { waits.push(input.milliseconds); state.now += input.milliseconds; return { ok: true, value: undefined }; },
    observer: { observe: event => { observations.push(event); } },
  };
}

/** Small fabricated endpoint table; counts/IDs expose order and duplicate POSTs. */
function fixtureResponse(required: { input: DispatchInput; state: InstagramFixture["state"]; mode: Mode }): Outcome<unknown> {
  const { input, state, mode } = required;
  const endpoint = input.request.endpoint;
  if (endpoint.endsWith("/media")) { state.creations += 1; return { ok: true, value: { id: String(200 + state.creations) } }; }
  if (endpoint.endsWith("/media_publish")) {
    if (mode === "timeout") return failure({ code: "unavailable", message: "Fixture acknowledgement lost" });
    if (mode === "malformed") return { ok: true, value: { id: "bad", access_token: "never-export" } };
    state.published = true; return { ok: true, value: { id: "9001" } };
  }
  if (endpoint.endsWith("/content_publishing_limit")) return { ok: true, value: { data: [{ quota_usage: state.quotaUsage, config: { quota_total: state.quotaTotal, quota_duration: 86400 } }] } };
  return { ok: true, value: { status_code: state.published ? "PUBLISHED" : state.containerStatus } };
}

export function instagramRequest(required: { post?: MetaInstagramPost; command?: MetaInstagramRequest["command"] } = {}): MetaInstagramRequest {
  return { context, connectionId: "connection", operationId: "instagram-operation", command: required.command ?? { kind: "instagram_publish_post", post: required.post ?? image } };
}

/** Exercise the public entry with injected ports; helpers do not bypass production parsing/mapping. */
export function invokeInstagramFixture(required: { fixture: InstagramFixture; request?: MetaInstagramRequest; configuration?: typeof configuration }, optional?: CallOptions) {
  const fixture = required.fixture;
  return invokeMetaInstagram({ request: required.request ?? instagramRequest(), dispatch: fixture.dispatch, clock: fixture.clock, wait: fixture.wait, observer: fixture.observer, configuration: required.configuration ?? configuration }, optional);
}
