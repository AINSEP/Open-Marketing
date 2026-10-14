/** Three named routes share the owner package list and upload controls. */
import { usePackages, usePackageRow } from '../model/packages.hooks.js';
import type { PackagePageProps, PackageRowProps } from '../model/packages.hooks.js';

/** Plugins, agent plugins and skills use the same install flow. */
export function PackagePage(props: PackagePageProps) {
  const page = usePackages(props);
  return <section className="settings-card" data-page="addons-packages" aria-label="Installed add-ons">
    <div className="appearance-control"><label>Upload ZIP<input type="file" accept=".zip" disabled={page.busy} onChange={page.upload} data-action="addons_install" data-addon-kind={props.kind} /></label><label>Upload folder<input type="file" multiple {...page.folderAttributes} disabled={page.busy} onChange={page.upload} data-action="addons_install" data-addon-kind={props.kind} /></label><button type="button" onClick={page.refresh} disabled={page.busy} data-action="addons_list">Refresh</button></div>
    <p className="muted">Upload your own add-on. New installations start disabled.</p>
    {page.busy && <p role="status">Updating add-ons…</p>}
    {page.error && <p role="alert" className="error-notice">{page.error}</p>}
    {page.notice && <p role="status">{page.notice}</p>}
    {!page.items.length && !page.error && <p>No add-ons installed here yet.</p>}
    <ul>{page.rows.map(renderPackageRow)}</ul>
    {page.cursor && <button type="button" onClick={page.next} disabled={page.busy} data-action="addons_list">Next page</button>}
  </section>;
}
/** Map ABI is a narrow markup wrapper; state/handlers remain in hooks. */
function renderPackageRow(row: PackageRowProps) { return <PackageRow key={row.addon.id} {...row} />; }
function PackageRow(props: PackageRowProps) {
  const row = usePackageRow(props);
  return <li><h2>{props.addon.name} <small>{props.addon.version}</small></h2><p>{props.addon.description}</p><p>{props.addon.enabled ? 'Enabled' : 'Disabled'}</p><button type="button" onClick={row.toggle} disabled={props.busy} data-action="addons_set_enabled" data-addon-id={props.addon.id}>{props.addon.enabled ? 'Disable' : 'Enable'}</button> <button type="button" onClick={row.remove} disabled={props.busy} data-action="addons_uninstall" data-addon-id={props.addon.id}>Uninstall</button></li>;
}
export function PluginsPage(props: Omit<PackagePageProps, 'kind'>) { return <PackagePage {...props} kind="plugin" />; }
export function AgentPluginsPage(props: Omit<PackagePageProps, 'kind'>) { return <PackagePage {...props} kind="agent-plugin" />; }
export function SkillsPage(props: Omit<PackagePageProps, 'kind'>) { return <PackagePage {...props} kind="skill" />; }
