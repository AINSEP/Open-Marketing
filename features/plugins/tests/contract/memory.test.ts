import { PluginRepoPortSuite, PluginLifecyclePortSuite, AgentPluginLayoutPortSuite, AgentPluginMcpProvisioningPortSuite, PluginTrustPortSuite, PluginAuditPortSuite, PluginObserverPortSuite } from "./port-suites.js";
import { createMemoryPluginRepo, createMemoryPluginLifecycle, createMemoryAgentPluginLayout, createMemoryAgentPluginMcpProvisioning, createMemoryPluginTrust, createMemoryPluginAudit, createMemoryPluginObserver } from "../../index.js";
import { memoryFixture, source } from "../fixtures/plugin.js";
PluginRepoPortSuite({ create: () => createMemoryPluginRepo({}) });
PluginLifecyclePortSuite({ create: () => ({ port: createMemoryPluginLifecycle({}, { packages: [memoryFixture({})] }), source }) });
AgentPluginLayoutPortSuite({ create: () => ({ port: createMemoryAgentPluginLayout({}, { packages: [memoryFixture({})] }), source }) });
AgentPluginMcpProvisioningPortSuite({ create: () => {
  const port = createMemoryAgentPluginMcpProvisioning({});
  return { port, bindings: () => port.bindings({}).map(binding => binding.plugin) };
} });
PluginTrustPortSuite({ create: () => ({ port: createMemoryPluginTrust({}, { packages: [memoryFixture({})] }), source }) });
PluginAuditPortSuite({ create: () => {
  const port = createMemoryPluginAudit({});
  return { port, entries: () => port.entries({}) };
} });
PluginObserverPortSuite({ create: () => {
  const port = createMemoryPluginObserver({});
  return { port, events: () => port.events({}) };
} });
