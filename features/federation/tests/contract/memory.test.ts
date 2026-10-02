import {
  FederationConnectionRepoPortSuite, McpTransportPortSuite, FederationCredentialPortSuite,
  FederatedToolPermissionGateSuite, FederatedCallConfirmationSuite, ExternalMcpToolApprovalRepoPortSuite,
  FederatedDispatchGatePortSuite, FederationAuditPortSuite, ToolRegistryPortSuite,
} from "./port-suites.js";
import {
  createMemoryFederationConnectionRepo, createMemoryMcpTransport, createMemoryFederationCredential,
  createMemoryFederatedToolPermissionGate, createMemoryFederatedCallConfirmation,
  createMemoryExternalMcpToolApprovalRepo, createMemoryFederatedDispatchGate, createMemoryFederationAudit,
  createMemoryToolRegistry,
} from "../../index.js";
import type { MemoryAudit } from "../../index.js";
import { context, call, connection, descriptor, respond } from "../fixtures/domain.js";

FederationConnectionRepoPortSuite({ create: () => createMemoryFederationConnectionRepo({ entries: [connection] }) });
McpTransportPortSuite({ name: "memory", create: async () => ({ port: createMemoryMcpTransport({ respond }), cleanup: async () => {} }) });
FederationCredentialPortSuite({ create: () => createMemoryFederationCredential({ entries: [{ connectionId: "fixture", credentialReference: "broker-reference" }] }) });
FederatedToolPermissionGateSuite({ create: () => createMemoryFederatedToolPermissionGate({ entries: [{ toolName: descriptor({}).name, effects: ["read"] }] }) });
FederatedCallConfirmationSuite({ create: () => createMemoryFederatedCallConfirmation({ approve: async () => ({ ok: true, value: { approvalId: "approval" } }) }) });
ExternalMcpToolApprovalRepoPortSuite({ create: () => createMemoryExternalMcpToolApprovalRepo({ entries: [{ context, call: call({}), approvalId: "approval", argumentsDigest: call({}).argumentsDigest, expiresAt: 1000, revoked: false }] }) });
FederatedDispatchGatePortSuite({ create: () => createMemoryFederatedDispatchGate({ entries: [{ context, call: call({}), permitId: "permit" }] }) });
FederationAuditPortSuite({ create: () => createMemoryFederationAudit({}), read: ({ port }) => (port as MemoryAudit).entries({}) });
ToolRegistryPortSuite({ create: () => createMemoryToolRegistry({}) });
