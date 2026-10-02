import { WorkspaceRepoPortSuite, IdentityPortSuite, AccountBindingLookupPortSuite, WorkspaceObserverPortSuite } from "./port-suites.js";
import { createMemoryWorkspaceRepo, createMemoryIdentity, createMemoryAccountBindingLookup, createMemoryWorkspaceObserver } from "../../index.js";
import { connections, createIds, sessions, workspaces } from "../fixtures.js";

function createHarness(required: Record<string, never>) {
  const identity = createMemoryIdentity({ sessions });
  const repo = createMemoryWorkspaceRepo({ identity, ids: createIds({}), workspaces, connections });
  return { repo, lookup: createMemoryAccountBindingLookup({ repo }), dispose() {} };
}
WorkspaceRepoPortSuite({ create: () => createHarness({}) });
IdentityPortSuite({ create: ({ clock }) => createMemoryIdentity({ clock, sessions: [...sessions, { ownerId: "owner-a", sessionId: "expiring", expiresAt: 100 }] }) });
AccountBindingLookupPortSuite({ create: () => createHarness({}) });
WorkspaceObserverPortSuite({ create: ({ events }) => createMemoryWorkspaceObserver({ events }) });
