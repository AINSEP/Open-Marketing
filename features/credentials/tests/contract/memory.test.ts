import { CredentialRepoPortSuite, SecretSealerPortSuite, KeyringPortSuite, OAuthClientPortSuite, CredentialLockPortSuite, CredentialAuditPortSuite, CredentialBrokerPortSuite, CredentialRefreshPortSuite, CredentialObserverPortSuite } from "./port-suites.js";
import { createMemoryCredentialRepo, createMemorySecretSealer, createMemoryKeyring, createMemoryOAuthClient, createMemoryCredentialLock, createMemoryCredentialAudit, createMemoryCredentialBroker, createMemoryCredentialRefresh, createMemoryCredentialObserver } from "../../index.js";
import { context, reference, storedSecret, value } from "../fixtures.js";

CredentialRepoPortSuite({ create: () => createMemoryCredentialRepo({}) });
SecretSealerPortSuite({ create: () => createMemorySecretSealer({}) });
KeyringPortSuite({ create: () => createMemoryKeyring({}) });
OAuthClientPortSuite({ create: () => createMemoryOAuthClient({}) });
CredentialLockPortSuite({ create: () => createMemoryCredentialLock({}) });
CredentialAuditPortSuite({ create: () => createMemoryCredentialAudit({}) });
CredentialObserverPortSuite({ create: () => createMemoryCredentialObserver({}) });
CredentialRefreshPortSuite({ create: () => createMemoryCredentialRefresh({ sealer: createMemorySecretSealer({}) }), record: { summary: { scope: context.scope, connectionId: reference.connectionId, pluginId: "plugin", status: "connected" }, reference, secret: storedSecret } });
CredentialBrokerPortSuite({ create: async () => {
  const repo = createMemoryCredentialRepo({});
  const sealer = createMemorySecretSealer({});
  const secret = value({ outcome: await sealer.seal({ reference, plaintext: "test-broker-token" }) });
  value({ outcome: await repo.store({ context, reference, secret, pluginId: "plugin" }) });
  return { port: createMemoryCredentialBroker({ repo, sealer }), repo, reference };
} });
