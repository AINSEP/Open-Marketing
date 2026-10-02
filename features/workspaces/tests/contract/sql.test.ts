import { AccountBindingLookupPortSuite, WorkspaceRepoPortSuite } from "./port-suites.js";
import { createSqlHarness } from "../sql-fixture.js";
WorkspaceRepoPortSuite({ create: () => createSqlHarness({}) });
AccountBindingLookupPortSuite({ create: () => createSqlHarness({}) });
