import { WorkspaceRepoPortSuite, IdentityPortSuite, AccountBindingLookupPortSuite, WorkspaceObserverPortSuite } from "./port-suites.js";
import { createMemoryWorkspaceRepo, createMemoryIdentity, createMemoryWorkspaceObserver } from "../../index.js";
import { connections, sessions, workspaces } from "../fixtures.js";

function createHarness(required: Record<string, never>) {
  const repo = createMemoryWorkspaceRepo({ workspaces, connections });
  return { repo, lookup: repo, dispose() {} };
}
WorkspaceRepoPortSuite({ create: () => createHarness({}) });
IdentityPortSuite({ create: ({ clock }) => createMemoryIdentity({ clock, sessions: [...sessions, { ownerId: "owner-a", sessionId: "expiring", expiresAt: 100 }] }) });
AccountBindingLookupPortSuite({ create: () => createHarness({}) });
WorkspaceObserverPortSuite({ create: ({ events }) => createMemoryWorkspaceObserver({ events }) });
