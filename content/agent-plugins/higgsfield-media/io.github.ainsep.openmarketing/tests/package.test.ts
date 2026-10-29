import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

describe("portable package and OM namespace", () => {
  it("retains copied-guidance attribution and marks pricing/OAuth fixtures as historical", () => {
    const notice = readFileSync(new URL("NOTICE", root), "utf8");
    const provenance = readFileSync(new URL("PROVENANCE.md", root), "utf8");
    expect(notice).toContain("Tovu");
    expect(provenance).toContain("96cdc66383ae3d8ea2791528f4e49f2e3102f11e");
    expect(provenance).toContain("No copied executable source");
    expect(JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/oauth-discovery.json", root), "utf8"))).toMatchObject({ authMode: "oauth", pkce: "S256", verifiedCurrent: false });
  });
});
