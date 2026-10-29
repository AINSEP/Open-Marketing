import { PolicyRepoPortSuite, PolicyObserverPortSuite } from "./port-suites.js";
import { createMemoryPolicyRepo } from "../../index.js";
import { memoryObserver } from "../fixtures.js";

PolicyRepoPortSuite({ name: "memory", create: () => ({ port: createMemoryPolicyRepo({}) }) });

PolicyObserverPortSuite({ create: memoryObserver });
