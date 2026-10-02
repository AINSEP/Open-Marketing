import { describe, it, expect } from "vitest";
import type { JobRepoPort, JobDispatchPort, JobAuthorizationPort } from "../../src/ports.js";
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function JobRepoPortSuite(required: {
    create: () => JobRepoPort;
}) {
    describe("JobRepoPort stub contract", () => {
        it("enqueue fails explicitly", async () => { const port = required.create(); const outcome = await port.enqueue({} as Parameters<JobRepoPort["enqueue"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok)
            expect(outcome.error.code).toBe("not_implemented"); });
        it("claim fails explicitly", async () => { const port = required.create(); const outcome = await port.claim({} as Parameters<JobRepoPort["claim"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok)
            expect(outcome.error.code).toBe("not_implemented"); });
    });
}
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function JobDispatchPortSuite(required: {
    create: () => JobDispatchPort;
}) {
    describe("JobDispatchPort stub contract", () => {
        it("dispatch fails explicitly", async () => { const port = required.create(); const outcome = await port.dispatch({} as Parameters<JobDispatchPort["dispatch"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok)
            expect(outcome.error.code).toBe("not_implemented"); });
    });
}
/** j00 absence contract. Owning job extends this SAME suite with behavioral assertions for double and real adapter. */
export function JobAuthorizationPortSuite(required: {
    create: () => JobAuthorizationPort;
}) {
    describe("JobAuthorizationPort stub contract", () => {
        it("authorize fails explicitly", async () => { const port = required.create(); const outcome = await port.authorize({} as Parameters<JobAuthorizationPort["authorize"]>[0]); expect(outcome.ok).toBe(false); if (!outcome.ok)
            expect(outcome.error.code).toBe("not_implemented"); });
    });
}
