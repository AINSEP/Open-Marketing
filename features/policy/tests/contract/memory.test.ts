import { PolicyRepoPortSuite, CanonicalIdentityPortSuite, PolicyObserverPortSuite } from "./port-suites.js";
import { createMemoryPolicyRepo, createMemoryCanonicalIdentity } from "../../index.js";
import { subject, memoryObserver } from "../fixtures.js";

PolicyRepoPortSuite({ name: "memory", create: () => ({ port: createMemoryPolicyRepo({ bindings: [{ identifier: "email:subject", subject }] }) }) });
CanonicalIdentityPortSuite({ name: "memory", create: () => ({ port: createMemoryCanonicalIdentity({ bindings: [{ identifier: "email:subject", subject }] }) }) });

PolicyObserverPortSuite({ create: memoryObserver });
