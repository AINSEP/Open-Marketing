import type { Outcome } from "@open-marketing/contracts";
export interface ElectronHostPort { open(required: { studioUrl: string; webPreferences: { contextIsolation: true; sandbox: true; nodeIntegration: false } }): Promise<Outcome<void>>; close(required: Record<string, never>): Promise<Outcome<void>> }
export interface ChildSupervisorPort { start(required: { child: "server" | "agent" }): Promise<Outcome<void>>; stop(required: { child: "server" | "agent" }): Promise<Outcome<void>> }
