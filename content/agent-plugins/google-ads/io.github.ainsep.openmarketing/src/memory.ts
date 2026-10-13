import type { Outcome } from "@open-marketing/contracts";
import { failure, success } from "./schema.ts";
import { operationIdentity } from "./rules.ts";
import type { AccountBinding, OperationJournalPort, OperationRecord } from "./types.ts";

/** Atomic in-memory test double. Production MUST bind the server's durable jobs metadata.
 * Copies prevent callers mutating journal evidence. reset/dispose are instance-owned.
 * @complexity O(1) claim/get, O(n) bounded findCampaign.
 * @example createMemoryJournal({ maxRecords: 1000 }) */
export function createMemoryJournal(required: { maxRecords: number }): OperationJournalPort & { reset(): void; dispose(): void; records(): OperationRecord[]; history(): OperationRecord[] } {
  const records = new Map<string, OperationRecord>();
  const history: OperationRecord[] = [];
  const validLimit = Number.isSafeInteger(required.maxRecords) && required.maxRecords >= 1 && required.maxRecords <= 10000;
  const limit = validLimit ? required.maxRecords : 0;
  let disposed = false;
  return {
    async claim(input) {
      if (disposed) return failure({ code: "unavailable", message: "Journal disposed" });
      const existing = records.get(input.record.key);
      if (existing) return success({ value: { acquired: false, record: structuredClone(existing) } });
      if (records.size >= limit) return failure({ code: "limit_exceeded", message: "Journal capacity reached" });
      records.set(input.record.key, structuredClone(input.record));
      history.push(structuredClone(input.record));
      return success({ value: { acquired: true, record: structuredClone(input.record) } });
    },
    async append(input) {
      if (disposed) return failure({ code: "unavailable", message: "Journal disposed" });
      const existing = records.get(input.record.key);
      if (!existing || existing.digest !== input.record.digest) return failure({ code: "conflict", message: "Journal identity mismatch" });
      if (history.length >= limit * 3) return failure({ code: "limit_exceeded", message: "Journal history capacity reached" });
      records.set(input.record.key, structuredClone(input.record));
      history.push(structuredClone(input.record));
      return success({ value: undefined });
    },
    async get(input) { return success({ value: structuredClone(records.get(input.key) ?? null) }); },
    async findCampaign(input) { return findCampaign({ records, ...input }); },
    reset() { records.clear(); history.length = 0; },
    dispose() { records.clear(); history.length = 0; disposed = true; },
    records() { return structuredClone([...records.values()]); },
    history() { return structuredClone(history); },
  };
}
function findCampaign(required: { records: Map<string, OperationRecord>; binding: AccountBinding; campaignId: string }): Outcome<OperationRecord | null> {
  const accountKey = operationIdentity({ binding: required.binding, operationId: "binding" }).key;
  const record = [...required.records.values()].find(record => record.accountKey === accountKey && record.name === "create_paused" && record.receipt.campaignId === required.campaignId && record.receipt.hierarchy?.customerId === required.binding.customerId);
  return success({ value: structuredClone(record ?? null) });
}
