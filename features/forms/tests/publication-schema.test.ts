import { expect, it } from "vitest";
import { publicationSchema } from "../index.js";
import { publication } from "./fixtures.js";
it("exports the owning full publication boundary without dropping CMS fields or consent metadata", () => {
    const input = publication({});
    expect(publicationSchema.parse(input)).toEqual(input);
    expect(publicationSchema.safeParse({ ...input, fields: [{ ...input.fields[0], type: "unrecognized" }] }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...input, consent: [{ ...input.consent[0], wordingDigest: "wrong" }] }).success).toBe(false);
    expect(publicationSchema.safeParse({ ...input, fields: Array(21).fill(input.fields[0]) }).success).toBe(false);
});
