import { WorkspaceRepoPortSuite, IdentityPortSuite, AccountBindingLookupPortSuite } from "./port-suites.js";
import { createMemoryWorkspaceRepo, createMemoryIdentity, createMemoryAccountBindingLookup } from "../../index.js";
WorkspaceRepoPortSuite({ create: () => createMemoryWorkspaceRepo({}) });
IdentityPortSuite({ create: () => createMemoryIdentity({}) });
AccountBindingLookupPortSuite({ create: () => createMemoryAccountBindingLookup({}) });
