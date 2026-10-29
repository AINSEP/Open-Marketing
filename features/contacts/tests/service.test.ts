import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { createContactService, createMemoryContactRepo, destinationIdentifierHash, identifierDigest, normalizePhoneE164 } from "../index.js";
import type { ContactRepoPort, ContactSuppressionPort, IdentifierInput, Subject } from "../index.js";
import { canonicalPair } from "../src/rules.js";
import { context, subject, value } from "./contract/port-suites.js";

const keys = { v1: new Uint8Array([1, 2, 3, 4]), v2: new Uint8Array([5, 6, 7, 8]) };
const email: IdentifierInput = { kind: "email", raw: " Alice@Example.TEST " };
const phone: IdentifierInput = { kind: "phone", raw: "+1 (213) 373-4253" };
const allowed: ContactSuppressionPort = { async assess() { return { ok: true, value: { allowed: true } }; } };

/** Deterministic clock/IDs and instance-owned storage; no globals are mutated by tests. */
function fixture(required: { repo?: ContactRepoPort; suppression?: ContactSuppressionPort; digest?: { activeKeyVersion: string; keys: Readonly<Record<string, Uint8Array>> } } = {}) {
  let next = 0;
  const repo = required.repo ?? createMemoryContactRepo({});
  const service = createContactService({ repo, suppression: required.suppression ?? allowed, clock: { now() { return 1000; } }, ids: { next() { return `id-${++next}`; } }, digest: required.digest ?? { activeKeyVersion: "v1", keys: { v1: keys.v1 } } });
  return { repo, service };
}
function sharing(required: { subjectId: string; context?: CallContext }) {
  return { context: required.context ?? context, subjectId: required.subjectId, destination: "account:google", purpose: "conversion_measurement" };
}

describe("contacts service identity", () => {
  it("normalizes and attaches identifiers to one canonical subject with independent hashes", async () => {
    const { service, repo } = fixture();
    const created = value({ outcome: await service.upsert({ context, identifiers: [email, phone], timezone: "America/Los_Angeles" }) });
    const repeated = value({ outcome: await service.upsert({ context, identifiers: [{ kind: "email", raw: "alice@example.test" }], timezone: "UTC" }) });
    expect(repeated.subjectId).toBe(created.subjectId);
    expect(repeated.timezone).toBe("UTC");
    expect(await service.resolve({ context, identifier: phone })).toEqual({ ok: true, value: repeated });
    const stored = value({ outcome: await repo.identifiersFor({ context, subjectId: created.subjectId }) });
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "email", normalizedValue: "alice@example.test", normalizationVersion: "v1", keyVersion: "v1" }), expect.objectContaining({ kind: "phone", normalizedValue: "+12133734253" })]));
    const destination = value({ outcome: await service.identifiersFor(sharing(created)) });
    expect(destination.identifiers).toEqual({ email: "69b1145a03334875161ea18c1373b5703aeeff144990a9f847867ff83ed5aaad", phone: "9f7ec22d72092cd3c0b58726ed9c2d91b92e51a3f29837508fb2948bb22dd2fd", phone_digits: "1f81adb30e11317806be982cc82769fbf8627833a89dd87cb24d282f71828830" });
    expect(destination.identifierDigests.phone_digits).toBe(destination.identifierDigests.phone);
    expect(destination.identifiers.phone_digits).not.toBe(destination.identifiers.phone);
    expect(destination.identifierDigests.email).not.toBe(destination.identifiers.email);
    expect(JSON.stringify(destination)).not.toContain("alice@example.test");
    expect(JSON.stringify(destination)).not.toContain("12133734253");
    expect(JSON.stringify(destination)).not.toContain("+12133734253");
  });
  it("keeps email aliases/dots and opaque customer ID case distinct", async () => {
    const { service } = fixture();
    const ids: string[] = [];
    for (const raw of ["a.b@gmail.com", "ab@gmail.com", "user+one@gmail.com", "user+two@gmail.com"]) ids.push(value({ outcome: await service.upsert({ context, identifiers: [{ kind: "email", raw }] }) }).subjectId);
    for (const raw of ["Customer42", "customer42"]) ids.push(value({ outcome: await service.upsert({ context, identifiers: [{ kind: "external_customer_id", raw }] }) }).subjectId);
    expect(new Set(ids).size).toBe(6);
  });
  it("does not create subjects from clicks or resolve by a click", async () => {
    const { service, repo } = fixture();
    expect(await service.upsert({ context, identifiers: [{ kind: "gclid", raw: "same-click" }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await service.resolve({ context, identifier: { kind: "gclid", raw: "same-click" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await repo.get({ context, subjectId: "id-1" })).toEqual({ ok: true, value: null });
  });
  it("shared clicks do not match or automatically merge separate stable identities", async () => {
    const { service } = fixture();
    const click: IdentifierInput = { kind: "gclid", raw: "same-click" };
    const first = value({ outcome: await service.upsert({ context, identifiers: [email, click] }) });
    const second = value({ outcome: await service.upsert({ context, identifiers: [phone, click] }) });
    expect(first.subjectId).not.toBe(second.subjectId);
    expect(await service.upsert({ context, identifiers: [email, phone] })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await service.resolve({ context, identifier: email })).toEqual({ ok: true, value: first });
    expect(await service.resolve({ context, identifier: phone })).toEqual({ ok: true, value: second });
  });
  it("returns a conflict when an injected ID collision would attach an unrelated identity", async () => {
    const first = fixture();
    const created = value({ outcome: await first.service.upsert({ context, identifiers: [email] }) });
    const second = fixture({ repo: first.repo });
    expect(await second.service.upsert({ context, identifiers: [phone] })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await first.repo.identifiersFor({ context, subjectId: created.subjectId }) })).toHaveLength(1);
    expect(await first.service.resolve({ context, identifier: phone })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("explicit reversed merges retain the earliest identity and replay once", async () => {
    const { service } = fixture();
    const first = value({ outcome: await service.upsert({ context, identifiers: [email] }) });
    const second = value({ outcome: await service.upsert({ context, identifiers: [phone] }) });
    const merged = value({ outcome: await service.merge({ context, sourceSubjectId: first.subjectId, targetSubjectId: second.subjectId }) });
    expect(merged.subjectId).toBe(first.subjectId);
    expect(merged.lineage).toEqual([{ sourceSubjectId: second.subjectId, targetSubjectId: first.subjectId, mergedAt: 1000 }]);
    expect(await service.merge({ context, sourceSubjectId: second.subjectId, targetSubjectId: first.subjectId })).toEqual({ ok: true, value: merged });
    expect(await service.resolve({ context, identifier: phone })).toEqual({ ok: true, value: merged });
    expect(value({ outcome: await service.identifiersFor(sharing(second)) }).subjectId).toBe(first.subjectId);
  });
  it("uses subject ID as the tie breaker for equal immutable creation orders", () => {
    const a = { ...subject({ id: "a" }), creationOrder: 1 };
    const b = { ...subject({ id: "b" }), creationOrder: 1 };
    expect(canonicalPair({ source: b, target: a })).toEqual({ winner: a, loser: b });
    expect(canonicalPair({ source: a, target: b })).toEqual({ winner: a, loser: b });
  });
  it("rejects invalid mixed batches, limits, timezone and unqualified phones before writes", async () => {
    const { service, repo } = fixture();
    for (const identifiers of [[], [email, { kind: "email" as const, raw: "invalid" }], [email, { kind: "phone" as const, raw: "2133734253" }], Array.from({ length: 21 }, () => email)]) {
      expect(await service.upsert({ context, identifiers })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(await service.upsert({ context, identifiers: [email], timezone: "Not/A_Timezone" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await service.upsert({ context: { ...context, traceId: "" }, identifiers: [email] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await repo.get({ context, subjectId: "id-1" })).toEqual({ ok: true, value: null });
    expect(await service.resolve({ context, identifier: email })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("accepts the exact batch limit and deduplicates normalized inputs", async () => {
    const { service, repo } = fixture();
    const created = value({ outcome: await service.upsert({ context, identifiers: Array.from({ length: 20 }, () => email) }) });
    expect(value({ outcome: await repo.identifiersFor({ context, subjectId: created.subjectId }) })).toHaveLength(1);
  });
  it("honors cancellation without touching storage", async () => {
    const { service, repo } = fixture();
    expect(await service.upsert({ context, identifiers: [email] }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await repo.get({ context, subjectId: "id-1" })).toEqual({ ok: true, value: null });
  });
});

describe("versioned identity digests and erasure", () => {
  it("uses a versioned HMAC message distinct from SHA-256; kind/key/version all matter", () => {
    const input = { kind: "email" as const, normalizedValue: "alice@example.test", key: keys.v1, keyVersion: "v1" };
    const expected = createHmac("sha256", keys.v1).update('["om.contacts.hmac.v1","email","v1","alice@example.test"]').digest("hex");
    expect(identifierDigest(input)).toEqual({ ok: true, value: expected });
    const outputs = [identifierDigest(input), identifierDigest({ ...input, kind: "external_customer_id" }), identifierDigest({ ...input, key: keys.v2 }), identifierDigest({ ...input, keyVersion: "v2" }), destinationIdentifierHash({ normalizedValue: input.normalizedValue })].map(outcome => value({ outcome }));
    expect(new Set(outputs).size).toBe(5);
    for (const output of outputs) expect(output).toMatch(/^[a-f0-9]{64}$/);
    expect(identifierDigest({ ...input, key: new Uint8Array() })).toMatchObject({ ok: false });
    expect(identifierDigest({ ...input, keyVersion: "" })).toMatchObject({ ok: false });
    expect(destinationIdentifierHash({ normalizedValue: "" })).toMatchObject({ ok: false });
  });
  it("looks up old versions during rotation and persists active-version identifiers", async () => {
    const first = fixture();
    const created = value({ outcome: await first.service.upsert({ context, identifiers: [email] }) });
    const rotated = fixture({ repo: first.repo, digest: { activeKeyVersion: "v2", keys } });
    expect(await rotated.service.resolve({ context, identifier: email })).toEqual({ ok: true, value: created });
    const updated = value({ outcome: await rotated.service.upsert({ context, identifiers: [email] }) });
    expect(updated.subjectId).toBe(created.subjectId);
    expect(value({ outcome: await first.repo.identifiersFor({ context, subjectId: created.subjectId }) }).map(item => item.keyVersion).sort()).toEqual(["v1", "v2"]);
    const missingKey = fixture({ repo: first.repo, digest: { activeKeyVersion: "v2", keys: { v2: keys.v2 } } });
    expect(await missingKey.service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await missingKey.service.upsert({ context, identifiers: [email] })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("returns a conflict when historical key versions point at different roots", async () => {
    const first = fixture();
    await first.service.upsert({ context, identifiers: [email] });
    await first.repo.upsert({ context, subject: subject({ id: "other" }), identifiers: [{ identifierId: "other-email", subjectId: "other", kind: "email", normalizedValue: "alice@example.test", normalizationVersion: "v1", keyVersion: "v2", identifierDigest: value({ outcome: identifierDigest({ kind: "email", normalizedValue: "alice@example.test", key: keys.v2, keyVersion: "v2" }) }) }] });
    const both = fixture({ repo: first.repo, digest: { activeKeyVersion: "v2", keys } });
    expect(await both.service.resolve({ context, identifier: email })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await both.service.upsert({ context, identifiers: [email] })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("keeps historical digest tombstones queryable and rejects rotated re-import/export", async () => {
    const first = fixture();
    const created = value({ outcome: await first.service.upsert({ context, identifiers: [email, { kind: "gclid", raw: "click" }], timezone: "UTC" }) });
    expect(await first.repo.purgeIdentifiers({ context, subjectId: created.subjectId })).toEqual({ ok: true, value: { purged: 2 } });
    const rotated = fixture({ repo: first.repo, digest: { activeKeyVersion: "v2", keys } });
    expect(await rotated.service.resolve({ context, identifier: email })).toMatchObject({ ok: true, value: { subjectId: created.subjectId } });
    expect(await rotated.service.upsert({ context, identifiers: [email] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await rotated.service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("rejects missing active keys and copies injected key bytes", async () => {
    const mutable = new Uint8Array(keys.v1);
    const copied = fixture({ digest: { activeKeyVersion: "v1", keys: { v1: mutable } } });
    mutable.fill(0);
    const created = value({ outcome: await copied.service.upsert({ context, identifiers: [email] }) });
    const stored = value({ outcome: await copied.repo.identifiersFor({ context, subjectId: created.subjectId }) })[0];
    expect(stored.identifierDigest).toBe(value({ outcome: identifierDigest({ kind: "email", normalizedValue: "alice@example.test", key: keys.v1, keyVersion: "v1" }) }));
    const missing = fixture({ digest: { activeKeyVersion: "v2", keys: { v1: keys.v1 } } });
    expect(await missing.service.upsert({ context, identifiers: [email] })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("current suppression and transient projection", () => {
  it("rechecks policy each time with scope, trace, purpose, destination and every local digest", async () => {
    const calls: Parameters<ContactSuppressionPort["assess"]>[0][] = [];
    let permit = true;
    const suppression: ContactSuppressionPort = { async assess(input) { calls.push(structuredClone(input)); return { ok: true, value: { allowed: permit } }; } };
    const { service, repo } = fixture({ suppression });
    const created = value({ outcome: await service.upsert({ context, identifiers: [email, phone] }) });
    const stored = value({ outcome: await repo.identifiersFor({ context, subjectId: created.subjectId }) });
    expect(await service.identifiersFor(sharing(created))).toMatchObject({ ok: true });
    expect(calls[0]).toEqual({ ...sharing(created), identifierDigests: stored.map(item => item.identifierDigest) });
    permit = false;
    expect(await service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(calls).toHaveLength(2);
  });
  it("fails closed for denied, returned-failure, thrown and malformed authority", async () => {
    const ports: ContactSuppressionPort[] = [
      { async assess() { return { ok: true, value: { allowed: false } }; } },
      { async assess() { return { ok: false, error: { code: "unavailable", message: "authority unavailable", retryable: false } }; } },
      { async assess() { throw new Error("secret dependency detail"); } },
      { async assess() { return { ok: true, value: { allowed: "yes" } } as unknown as Outcome<{ allowed: boolean }>; } },
    ];
    for (const suppression of ports) {
      const { service } = fixture({ suppression });
      const created = value({ outcome: await service.upsert({ context, identifiers: [email] }) });
      const output = await service.identifiersFor(sharing(created));
      expect(output.ok).toBe(false);
      expect(JSON.stringify(output)).not.toContain("secret dependency detail");
    }
  });
  it("uses identical SHA-256 for arbitrary admitted destinations and denies unknown authority", async () => {
    const suppression: ContactSuppressionPort = { async assess(input) { return { ok: true, value: { allowed: ["account:google", "account:meta"].includes(input.destination) } }; } };
    const { service } = fixture({ suppression });
    const created = value({ outcome: await service.upsert({ context, identifiers: [email, phone] }) });
    const google = value({ outcome: await service.identifiersFor(sharing(created)) });
    const meta = value({ outcome: await service.identifiersFor({ ...sharing(created), destination: "account:meta" }) });
    expect(meta).toEqual(google);
    expect(await service.identifiersFor({ ...sharing(created), destination: "unknown" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("deterministically selects scalar fields, preserves supplied fbc and never invents it", async () => {
    const { service } = fixture();
    const created = value({ outcome: await service.upsert({ context, identifiers: [email, { kind: "email", raw: "a@example.test" }, { kind: "external_customer_id", raw: "Customer42" }, { kind: "fbclid", raw: "standalone-click" }, { kind: "fbc", raw: "fb.1.1710000000123.captured" }, { kind: "fbp", raw: "fb.1.1710000000123.1234" }, { kind: "gclid", raw: "CaseSensitive_Click" }] }) });
    const output = value({ outcome: await service.identifiersFor(sharing(created)) });
    expect(output.identifiers.email).toBe("16cf3de9fd08355b5c5d128e2ab1051836fe3c6ce88c76de8d2ad17649c3e3a7");
    expect(output.identifiers.fbc).toBe("fb.1.1710000000123.captured");
    expect(output.identifiers.gclid).toBe("CaseSensitive_Click");
    expect(output.identifiers.external_id).toMatch(/^[a-f0-9]{64}$/);
    expect(output.identifiers.fbclid).toBeUndefined();
    expect(output.identifiers.click_time_ms).toBeUndefined();
    expect(Object.keys(output.identifierDigests).sort()).toEqual(Object.keys(output.identifiers).sort());
    const second = fixture();
    const standalone = value({ outcome: await second.service.upsert({ context, identifiers: [email, { kind: "fbclid", raw: "standalone" }] }) });
    expect(value({ outcome: await second.service.identifiersFor(sharing(standalone)) }).identifiers.fbc).toBeUndefined();
  });
  it("accepts ServiceContext and validates malformed repository outputs", async () => {
    const base = fixture();
    const created = value({ outcome: await base.service.upsert({ context, identifiers: [email] }) });
    const serviceContext = { scope: context.scope, serviceId: "measurement-worker", correlationId: context.correlationId, traceId: context.traceId };
    expect(await base.service.identifiersFor({ ...sharing(created), context: serviceContext })).toMatchObject({ ok: true });
    const wrongScope: Subject = { ...created, scope: { ...created.scope, workspaceId: "other" } };
    const badSubject = fixture({ repo: { ...base.repo, async get() { return { ok: true, value: wrongScope }; } } });
    expect(await badSubject.service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const badIdentifiers = fixture({ repo: { ...base.repo, async identifiersFor() { return { ok: true, value: [{ kind: "email" }] } as unknown as Awaited<ReturnType<ContactRepoPort["identifiersFor"]>>; } } });
    expect(await badIdentifiers.service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const empty = fixture({ repo: { ...base.repo, async identifiersFor() { return { ok: true, value: [] }; } } });
    expect(await empty.service.identifiersFor(sharing(created))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("strict phone parsing rejects extensions and embedded prose", () => {
    expect(normalizePhoneE164({ raw: "+12133734253 ext. 123" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(normalizePhoneE164({ raw: "Call +12133734253" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
