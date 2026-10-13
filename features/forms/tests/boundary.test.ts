import { describe, expect, it } from "vitest";
import { FormSubmissionValidationError } from "@jini-ai/cms/forms";
import { formsBoundary } from "../src/jini.js";

/** Regression (2026-10-13): the server's transaction owner wraps thrown errors in a
 * transaction_failed error with `cause`; invalid answers must still map to invalid_input
 * (HTTP 400), not a generic retryable "Forms boundary failed" (503). */
describe("forms boundary classification", () => {
  it("classifies a Jini validation error wrapped by a transaction owner", async () => {
    const invalid = new FormSubmissionValidationError({ message: "bad", fieldErrors: [{ field: "email", reason: "invalid" }] });
    const wrapped = new Error("Transaction body failed; kernel rolls back", { cause: invalid });
    const result = await formsBoundary({ work: async () => { throw wrapped; } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("still maps unknown failures to unavailable", async () => {
    const result = await formsBoundary({ work: async () => { throw new Error("driver", { cause: new Error("opaque") }); } });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
