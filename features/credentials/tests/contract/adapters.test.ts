import { afterEach, describe, expect, it } from "vitest";
import { CredentialRepoPortSuite, SecretSealerPortSuite, KeyringPortSuite, OAuthClientPortSuite, CredentialAuditPortSuite, CredentialBrokerPortSuite } from "./port-suites.js";
import { createAesGcmSecretSealer, createCredentialKeyring, createSqlCredentialRepo, createSqlCredentialAudit, createCredentialBroker, createBoundOAuthClient, createMemoryCredentialLock, createMemorySecretSealer } from "../../index.js";
import type { CredentialSqlPort } from "../../index.js";
import { createSqlFixture } from "../sql-fixture.js";
import { clock, configuration, context, reference, value } from "../fixtures.js";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
/** Keep fixture I/O confined to test bodies and release every native handle. */
function database(required: Record<string, never>): CredentialSqlPort {
  const fixture = createSqlFixture({});
  disposers.push(fixture.dispose);
  return fixture.db;
}
/** Known master/nonce fixtures exercise real AES-GCM and HKDF without runtime I/O. */
function sealer(required: Record<string, never>) {
  let nonce = 0;
  return createAesGcmSecretSealer({ keyring: createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) }), configuration, randomBytes: input => new Uint8Array(input.size).fill(++nonce) });
}
CredentialRepoPortSuite({ create: () => createSqlCredentialRepo({ db: database({}), clock }) });
SecretSealerPortSuite({ create: () => sealer({}) });
KeyringPortSuite({ create: () => createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) }) });
CredentialAuditPortSuite({ create: () => createSqlCredentialAudit({ db: database({}), clock, ids: { next() { return "audit-event"; } } }) });
CredentialBrokerPortSuite({ create: async () => {
  const db = database({});
  const repo = createSqlCredentialRepo({ db, clock });
  const secretSealer = sealer({});
  const secret = value({ outcome: await secretSealer.seal({ reference, plaintext: "persistent-broker-token" }) });
  value({ outcome: await repo.store({ context, reference, secret, pluginId: "plugin" }) });
  let nextId = 0;
  const audit = createSqlCredentialAudit({ db, clock, ids: { next() { return `audit-${++nextId}`; } } });
  return { port: createCredentialBroker({ repo, sealer: secretSealer, locks: createMemoryCredentialLock({}), audit }), repo, reference };
} });
OAuthClientPortSuite({ create: () => {
  let nextId = 0;
  const vault = createMemorySecretSealer({});
  return createBoundOAuthClient({ clock, ids: { next() { return `transaction-${++nextId}`; } }, allowedReturnUris: ["https://studio.example/callback"], allowedAuthorizationOrigins: ["https://oauth.example"], bindings: {
    async authorize(input) {
      const url = new URL("https://oauth.example/authorize");
      url.searchParams.set("state", "S".repeat(43));
      url.searchParams.set("redirect_uri", input.request.returnUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "C".repeat(43));
      url.searchParams.set("code_challenge_method", "S256");
      return { ok: true, value: { authorizationUrl: url.href, expiresAt: clock.now({}) + 300000 } };
    },
    async exchange(input) { return vault.seal({ reference: input.reference, plaintext: "host-test-token" }); },
  } });
} });

describe("persistent boundary failures", () => {
  it("redacts database exceptions and rejects tainted rows", async () => {
    const throwing: CredentialSqlPort = { async query() { throw new Error("secret-database-password"); } };
    const failed = await createSqlCredentialRepo({ db: throwing, clock }).get({ context, connectionId: "connection" });
    expect(failed).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(failed)).not.toContain("secret-database-password");
    const bad: CredentialSqlPort = { async query<Row extends Record<string, unknown>>() { return { rows: [{ status: "connected", ciphertext: "raw-token" } as unknown as Row], rowCount: 1 }; } };
    expect(await createSqlCredentialRepo({ db: bad, clock }).get({ context, connectionId: "connection" })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
});
