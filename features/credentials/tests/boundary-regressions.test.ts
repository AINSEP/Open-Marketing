import { describe, expect, it } from "vitest";
import { createCredentialBroker, createMemoryCredentialAudit, createMemoryCredentialLock, createMemoryCredentialRepo, createMemorySecretSealer } from "../index.js";
import { hostContext, reference } from "./fixtures.js";

describe("safe credential recovery messages", () => {
  it("preserves actionable reconnect guidance through the boundary wrapper", async () => {
    const repo = createMemoryCredentialRepo({});
    const broker = createCredentialBroker({ repo, audit: createMemoryCredentialAudit({}), locks: createMemoryCredentialLock({}), sealer: createMemorySecretSealer({}) });
    const result = await broker.use({ context: hostContext, reference, operationId: "dispatch" });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated", message: "Connection unavailable; reconnect required" } });
  });
});
