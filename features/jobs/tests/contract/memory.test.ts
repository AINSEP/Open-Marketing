import { JobRepoPortSuite, JobDispatchPortSuite, JobAuthorizationPortSuite } from "./port-suites.js";
import { createMemoryJobRepo, createMemoryJobDispatch, createMemoryJobAuthorization } from "../../index.js";
JobRepoPortSuite({ create: () => createMemoryJobRepo({}) });
JobDispatchPortSuite({ create: () => createMemoryJobDispatch({}) });
JobAuthorizationPortSuite({ create: () => createMemoryJobAuthorization({}) });
