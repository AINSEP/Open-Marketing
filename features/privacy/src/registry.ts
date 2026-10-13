import { idSchema } from "@open-marketing/contracts";
import type { ErasureParticipantPort, ErasureParticipantRegistry } from "./ports.js";
import { failure } from "./validation.js";

/** Instance-owned registry; reset clears it, dispose permanently closes it. No effects on registration.
 * @example const participants = createErasureParticipantRegistry({}); participants.register({ participant });
 * @complexity O(1) mutations, O(n) snapshot, n<=100; O(n) owned state.
 */
export function createErasureParticipantRegistry(_required: Record<string, never>): ErasureParticipantRegistry {
  const participants = new Map<string, ErasureParticipantPort>();
  let disposed = false;
  const closed = () => disposed ? failure({ code: "unavailable", message: "Erasure registry disposed" }) : undefined;
  return {
    register({ participant }) {
      const denied = closed();
      if (denied) return denied;
      if (!idSchema.safeParse(participant?.id).success || typeof participant?.run !== "function") return failure({ code: "invalid_input", message: "Invalid erasure participant" });
      if (participants.has(participant.id)) return failure({ code: "conflict", message: "Duplicate erasure participant" });
      if (participants.size >= 100) return failure({ code: "limit_exceeded", message: "Erasure participant limit exceeded" });
      participants.set(participant.id, Object.freeze({ id: participant.id, run: participant.run.bind(participant) }));
      return { ok: true, value: undefined };
    },
    unregister({ id }) {
      const denied = closed();
      if (denied) return denied;
      if (!idSchema.safeParse(id).success) return failure({ code: "invalid_input", message: "Invalid erasure participant ID" });
      participants.delete(id);
      return { ok: true, value: undefined };
    },
    list() { return closed() ?? { ok: true, value: [...participants.values()] }; },
    reset() { const denied = closed(); if (denied) return denied; participants.clear(); return { ok: true, value: undefined }; },
    dispose() { disposed = true; participants.clear(); return { ok: true, value: undefined }; },
  };
}
