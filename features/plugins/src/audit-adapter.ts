import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { PluginAuditPort } from "./ports.js";
import { attempt, success } from "./results.js";

/** Append-only server audit adapter. Writes the caller's context and operation, never package data.
 * Host append must never overwrite an earlier event; corrections append separate linked events.
 * @example createPluginAuditAdapter({ append: serverAuditAppend })
 * @complexity O(1) effect per bounded entry.
 */
export function createPluginAuditAdapter(required: {
  append(required: Parameters<PluginAuditPort["record"]>[0], optional?: CallOptions): Promise<void>;
}): PluginAuditPort {
  return { async record(input, options): Promise<Outcome<void>> {
    return attempt({ run: async () => { await required.append(structuredClone(input), options); return success({ value: undefined }); } });
  } };
}
