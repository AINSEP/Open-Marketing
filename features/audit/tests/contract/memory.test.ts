import { AuditRepoPortSuite, AuditRedactorPortSuite } from "./port-suites.js";
import { createMemoryAuditRepo, createMemoryAuditRedactor } from "../../index.js";
AuditRepoPortSuite({ create: () => createMemoryAuditRepo({}) });
AuditRedactorPortSuite({ create: () => createMemoryAuditRedactor({}) });
