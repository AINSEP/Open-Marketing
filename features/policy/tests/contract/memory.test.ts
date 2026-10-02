import { PolicyRepoPortSuite, CanonicalIdentityPortSuite } from "./port-suites.js";
import { createMemoryPolicyRepo, createMemoryCanonicalIdentity } from "../../index.js";
PolicyRepoPortSuite({ create: () => createMemoryPolicyRepo({}) });
CanonicalIdentityPortSuite({ create: () => createMemoryCanonicalIdentity({}) });
