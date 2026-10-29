import type { AddonKind, AddonUpload, AddonList, AddonSummary, AddonUninstallReceipt, CallContext, CallOptions,
    InstallAddon, IdPort, ObserverPort, Outcome, SetAddonEnabled, UninstallAddon } from '@open-marketing/contracts';
import type { PluginAuditPort } from './ports.js';
/** Prepared bytes cannot change between inspection and commit. Discovery reads no full instructions. */
export type PreparedAddon = { summary: AddonSummary; commit(required: { previous?: AddonSummary }): Promise<void> };
export type AddonDescription = { effects?: unknown; instructions?: string; skills?: readonly { name: string; description: string }[];
    tools?: readonly { name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; effects?: unknown }[] };
/** The three concrete Jini adapters and fixture double implement this small, current-use boundary. */
export interface AddonPackageAdapter {
    prepare(required: { context: CallContext; files: ReadonlyMap<string, Uint8Array>; revision: string }): Promise<PreparedAddon>;
    setEnabled(required: { context: CallContext; addon: AddonSummary; enabled: boolean }): Promise<void>;
    remove(required: { context: CallContext; addon: AddonSummary }): Promise<void>;
    describe(required: { context: CallContext; addon: AddonSummary; skill?: string }): Promise<AddonDescription>;
}
export interface AddonRepository {
    list(required: { context: CallContext }): Promise<AddonSummary[]>;
    save(required: { context: CallContext; addon: AddonSummary }): Promise<void>;
    remove(required: { context: CallContext; kind: AddonKind; id: string }): Promise<void>;
}
export interface AddonDependencies {
    repo: AddonRepository; packages: Record<AddonKind, AddonPackageAdapter>; decodeUpload(required: { upload: AddonUpload }, optional?: CallOptions): Promise<Outcome<{ kind: AddonKind; files: ReadonlyMap<string, Uint8Array>; revision: string }>>;
    audit: PluginAuditPort;
    ids: IdPort;
    runningJobs(required: { context: CallContext; kind: AddonKind; id: string }, optional?: CallOptions): Promise<Outcome<number>>;
    observer: ObserverPort;
}
export interface PluginService {
    list(required: { context: CallContext; query: { limit: number; cursor?: string; kind?: AddonKind } }, optional?: CallOptions): Promise<Outcome<AddonList>>;
    install(required: { context: CallContext; request: InstallAddon }, optional?: CallOptions): Promise<Outcome<AddonSummary>>;
    setEnabled(required: { context: CallContext; request: SetAddonEnabled }, optional?: CallOptions): Promise<Outcome<AddonSummary>>;
    uninstall(required: { context: CallContext; request: UninstallAddon }, optional?: CallOptions): Promise<Outcome<AddonUninstallReceipt>>;
    describe(required: { context: CallContext; kind: AddonKind; id: string; revision: string; skill?: string }, optional?: CallOptions): Promise<Outcome<AddonDescription>>;
}

