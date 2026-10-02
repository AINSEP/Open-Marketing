import { navigationActionSchema, navigationTargetSchema, navigationResultSchema, parseBoundary } from "@open-marketing/contracts";
import type { NavigationAction, NavigationResult, Outcome } from "@open-marketing/contracts";
/** HTTP client port. Only a browser execution acknowledgement can report completed. */
export interface AppControlHttpPort { request(required: NavigationAction): Promise<Outcome<unknown>> }
/** Retained flag validation intent, now restricted to real OM destinations. No shell execution or false acknowledgement. */
export async function runAppControlToolCli(required: { argv: readonly string[]; client: AppControlHttpPort; actionId: string }): Promise<Outcome<NavigationResult>> {
 const [command, ...rest] = required.argv;
 if (command !== "navigate") return { ok: false, error: { code: "invalid_input", message: "Expected navigate --target <OM destination>", retryable: false } };
 const flag = rest.find(value => value.startsWith("--target="));
 const index = rest.indexOf("--target");
 const target = flag?.slice(9) ?? rest[index + 1];
 const parsed = parseBoundary({ schema: navigationTargetSchema, input: target });
 if (!parsed.ok) return parsed;
 const action = parseBoundary({ schema: navigationActionSchema, input: { kind: "navigate", actionId: required.actionId, target: parsed.value } });
 if (!action.ok) return action;
 const response = await required.client.request(action.value);
 if (!response.ok) return response;
 const result = parseBoundary({ schema: navigationResultSchema, input: response.value });
 if (!result.ok) return result;
 if (result.value.actionId !== required.actionId || (result.value.status === "completed" && result.value.target !== parsed.value)) return { ok: false, error: { code: "invalid_input", message: "Navigation acknowledgement mismatch", retryable: false } };
 return result;
}
