import { AddonRepositorySuite, PluginAuditPortSuite, PluginObserverPortSuite } from './port-suites.js';
import { createMemoryPluginRepo, createMemoryPluginAudit, createMemoryPluginObserver } from '../../index.js';
AddonRepositorySuite({ create: () => ({ repo: createMemoryPluginRepo({}), dispose() {} }) });
PluginAuditPortSuite({ create: () => { const port = createMemoryPluginAudit({}); return { port, entries: () => port.entries({}) }; } });
PluginObserverPortSuite({ create: () => { const port = createMemoryPluginObserver({}); return { port, events: () => port.events({}) }; } });
