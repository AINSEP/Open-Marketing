import { PluginRepoPortSuite, PluginLifecyclePortSuite, AgentPluginLayoutPortSuite, AgentPluginMcpProvisioningPortSuite, PluginTrustPortSuite, PluginAuditPortSuite } from "./port-suites.js";
import { createMemoryPluginRepo, createMemoryPluginLifecycle, createMemoryAgentPluginLayout, createMemoryAgentPluginMcpProvisioning, createMemoryPluginTrust, createMemoryPluginAudit } from "../../index.js";
PluginRepoPortSuite({ create: () => createMemoryPluginRepo({}) });
PluginLifecyclePortSuite({ create: () => createMemoryPluginLifecycle({}) });
AgentPluginLayoutPortSuite({ create: () => createMemoryAgentPluginLayout({}) });
AgentPluginMcpProvisioningPortSuite({ create: () => createMemoryAgentPluginMcpProvisioning({}) });
PluginTrustPortSuite({ create: () => createMemoryPluginTrust({}) });
PluginAuditPortSuite({ create: () => createMemoryPluginAudit({}) });
