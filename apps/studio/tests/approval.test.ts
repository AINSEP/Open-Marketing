import { it, expect } from "vitest";
import { prepareApproval, readApprovalCard } from "../src/features/approve/index.js";
import { sampleCards } from "../src/shared/api/sample-data.js";
import { testRuntime } from "./support/runtime.js";

it("approval echoes exact server identifiers and arguments digest without reconstructing arguments", () => {
  const { runtime } = testRuntime(); const [card] = sampleCards({ clock: runtime.clock });
  const before = JSON.stringify(card.arguments);
  expect(prepareApproval({ card, choice: "allow", now: 1000 })).toEqual({ ok: true, value: { cardId: "sample-generation", operationId: "sample-generate-01", argumentsDigest: "a".repeat(64), choice: "allow" } });
  expect(JSON.stringify(card.arguments)).toBe(before);
});
it("generation allowance distinctions come from server choices; spend and destructive cards fail broad grants closed", () => {
  const { runtime } = testRuntime(); const [under, spend, unknown] = sampleCards({ clock: runtime.clock });
  expect(prepareApproval({ card: under, choice: "always_allow", now: 1000 }).ok).toBe(true);
  expect(prepareApproval({ card: unknown, choice: "always_allow", now: 1000 }).ok).toBe(false);
  expect(prepareApproval({ card: spend, choice: "allow_chat", now: 1000 }).ok).toBe(false);
  expect(readApprovalCard({ input: { ...spend, allowedChoices: ["allow", "always_allow"] } }).ok).toBe(false);
  expect(readApprovalCard({ input: { ...spend, classification: "destructive", allowedChoices: ["allow_chat"] } }).ok).toBe(false);
});
it("expiry is half-open and sensitive nested arguments are rejected intact", () => {
  const { runtime } = testRuntime(); const [card] = sampleCards({ clock: runtime.clock });
  expect(prepareApproval({ card, choice: "allow", now: card.expiresAt - 1 }).ok).toBe(true);
  expect(prepareApproval({ card, choice: "allow", now: card.expiresAt }).ok).toBe(false);
  expect(readApprovalCard({ input: { ...card, arguments: { nested: { access_token: "private-value" } } } }).ok).toBe(false);
  expect(readApprovalCard({ input: { ...card, arguments: { authorization: "Bearer private-value" } } }).ok).toBe(false);
});
