import { CredentialRepoPortSuite, SecretSealerPortSuite, KeyringPortSuite, OAuthClientPortSuite, CredentialLockPortSuite, CredentialAuditPortSuite, CredentialBrokerPortSuite } from "./port-suites.js";
import { createMemoryCredentialRepo, createMemorySecretSealer, createMemoryKeyring, createMemoryOAuthClient, createMemoryCredentialLock, createMemoryCredentialAudit, createMemoryCredentialBroker } from "../../index.js";
CredentialRepoPortSuite({ create: () => createMemoryCredentialRepo({}) });
SecretSealerPortSuite({ create: () => createMemorySecretSealer({}) });
KeyringPortSuite({ create: () => createMemoryKeyring({}) });
OAuthClientPortSuite({ create: () => createMemoryOAuthClient({}) });
CredentialLockPortSuite({ create: () => createMemoryCredentialLock({}) });
CredentialAuditPortSuite({ create: () => createMemoryCredentialAudit({}) });
CredentialBrokerPortSuite({ create: () => createMemoryCredentialBroker({}) });
