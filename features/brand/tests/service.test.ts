import { describe, expect, it } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { brandKitSchema, brandRevisionSchema, confirmBrandRevision, createMemoryBrandRepo, getBrandRevision, getConfirmedBrand, saveBrandDraft } from "../index.js";
import type { BrandKit, BrandRepoPort, BrandRevision } from "../index.js";

const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const kit: BrandKit = { business: { name: "Acme", facts: ["Owner supplied"] }, offers: [], audience: { pains: [], goals: [] }, voice: { use: [], avoid: [] }, colours: [], fonts: [], logoAssetIds: [], assetIds: [], prohibitedClaims: [] };
const clock = { now: () => 123 };
/** Establish fixture success before asserting state or deriving subsequent input. */
function unwrap<T>(required: { result: Outcome<T> }): T {
  if (!required.result.ok) throw new Error(required.result.error.code);
  return required.result.value;
}

describe("brand workflow", () => {
  it("allows extraction drafts but only the scoped owner can confirm the exact current draft", async () => {
    const repo = createMemoryBrandRepo({});
    const agent: CallContext = { ...context, principal: { kind: "agent", agentInstanceId: "extractor", runId: "run" } };
    const draft = unwrap({ result: await saveBrandDraft({ context: agent, kit, expectedRevision: 0, repo, clock }) });
    expect(draft).toMatchObject({ status: "draft", revision: 1, actor: agent.principal, at: 123, correlationId: "correlation", traceId: "trace", runId: "run" });
    const service: CallContext = { ...context, principal: { kind: "service", serviceId: "extractor" } };
    const wrongOwner: CallContext = { ...context, principal: { kind: "owner", ownerId: "other" } };
    for (const denied of [agent, service, wrongOwner]) expect(await confirmBrandRevision({ context: denied, revision: 1, repo, clock })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(unwrap({ result: await getConfirmedBrand({ context, repo }) })).toBeNull();
    const confirmed = unwrap({ result: await confirmBrandRevision({ context, revision: 1, repo, clock }) });
    expect(confirmed).toMatchObject({ revision: 2, status: "confirmed", actor: context.principal, kit: draft.kit });
    expect(await confirmBrandRevision({ context, revision: 2, repo, clock })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const nextKit = { ...kit, business: { name: "New proposal", facts: [] } };
    unwrap({ result: await saveBrandDraft({ context: agent, kit: nextKit, expectedRevision: 2, repo, clock }) });
    expect(unwrap({ result: await getConfirmedBrand({ context, repo }) })).toEqual(confirmed);
    expect(unwrap({ result: await getBrandRevision({ context, revision: 1, repo }) })).toEqual(draft);
    expect(await confirmBrandRevision({ context, revision: 1, repo, clock })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("handles missing drafts and a draft changed between read and confirmation append", async () => {
    const repo = createMemoryBrandRepo({});
    expect(await confirmBrandRevision({ context, revision: 1, repo, clock })).toMatchObject({ ok: false, error: { code: "conflict" } });
    unwrap({ result: await saveBrandDraft({ context, kit, expectedRevision: 0, repo, clock }) });
    const racing: BrandRepoPort = { ...repo, async read(input, options) {
      const snapshot = await repo.read(input, options);
      unwrap({ result: await saveBrandDraft({ context, kit: { ...kit, business: { name: "Changed", facts: [] } }, expectedRevision: 1, repo, clock }) });
      return snapshot;
    } };
    expect(await confirmBrandRevision({ context, revision: 1, repo: racing, clock })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(unwrap({ result: await getBrandRevision({ context, repo }) })?.revision).toBe(2);
    expect(unwrap({ result: await getConfirmedBrand({ context, repo }) })).toBeNull();
  });
  it("maps throwing dependencies and cancellation to explicit failures", async () => {
    const repo = createMemoryBrandRepo({});
    const throwing = { ...repo, async read(): Promise<Outcome<BrandRevision | null>> { throw new Error("storage"); }, async readConfirmed(): Promise<Outcome<BrandRevision | null>> { throw new Error("storage"); }, async append(): Promise<Outcome<BrandRevision>> { throw new Error("storage"); } };
    expect(await getBrandRevision({ context, repo: throwing })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await getConfirmedBrand({ context, repo: throwing })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await confirmBrandRevision({ context, revision: 1, repo: throwing, clock })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await saveBrandDraft({ context, kit, expectedRevision: 0, repo: throwing, clock })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await saveBrandDraft({ context, kit, expectedRevision: 0, repo, clock: { now() { throw new Error("clock"); } } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await saveBrandDraft({ context, kit, expectedRevision: 0, repo, clock: { now: () => NaN } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const options = { signal: AbortSignal.abort() };
    expect(await saveBrandDraft({ context, kit, expectedRevision: 0, repo, clock }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await confirmBrandRevision({ context, revision: 1, repo, clock }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await getBrandRevision({ context, repo }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await getConfirmedBrand({ context, repo }, options)).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
  it("rejects injected authority and unsafe expected versions without appending", async () => {
    const repo = createMemoryBrandRepo({});
    const injected = { ...kit, status: "confirmed" };
    expect(await saveBrandDraft({ context, kit: injected, expectedRevision: 0, repo, clock })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) expect((await saveBrandDraft({ context, kit, expectedRevision, repo, clock })).ok).toBe(false);
    expect(unwrap({ result: await getBrandRevision({ context, repo }) })).toBeNull();
  });
});

describe("bounded brand schemas", () => {
  it("accepts a complete kit and rejects unknown fields at nested boundaries", () => {
    expect(brandKitSchema.safeParse(kit).success).toBe(true);
    expect(brandKitSchema.safeParse({ ...kit, business: { ...kit.business, confirmed: true } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, offers: [{ name: "Offer", facts: ["Fact"], confirmed: true }] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, logoAssetIds: [""] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, colours: [{ role: "accent", hex: "red" }] }).success).toBe(false);
    const forged = { scope: context.scope, revision: 1, status: "confirmed", kit, actor: { kind: "service", serviceId: "extractor" }, at: 123, correlationId: "c", traceId: "t" };
    expect(brandRevisionSchema.safeParse(forged).success).toBe(false);
  });
  it("bounds collections, individual items, and aggregate UTF-8 bytes", () => {
    expect(brandKitSchema.safeParse({ ...kit, business: { name: "x".repeat(2_001), facts: [] } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, voice: { use: Array(51).fill("word"), avoid: [] } }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, offers: Array(21).fill({ name: "Offer", facts: [] }) }).success).toBe(false);
    expect(brandKitSchema.safeParse({ ...kit, offers: [{ name: "Offer", facts: Array(11).fill("fact") }] }).success).toBe(false);
    const nearLimit = { ...kit, business: { name: "Acme", facts: Array(50).fill("a".repeat(2_000)) } };
    expect(brandKitSchema.safeParse(nearLimit).success).toBe(true);
    const tooManyBytes = { ...nearLimit, business: { name: "Acme", facts: Array(50).fill("界".repeat(2_000)) } };
    expect(brandKitSchema.safeParse(tooManyBytes).success).toBe(false);
  });
});
