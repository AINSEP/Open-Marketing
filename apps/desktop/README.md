# Local unsigned Mac package

Build on an Intel Mac (x64), using Node 24.2.0/pnpm 10.24.0 and the installed
electron-builder 26.15.3 + Electron 39.2.3. Supply Node explicitly; Electron is read locally.
Builder configuration lives in `development/scripts/package-desktop.mjs`: `npmRebuild: true`
allows `beforeBuild: () => false` to disable installs and automatic dependency collection.
Staged Zod is explicitly mapped into the app; server/agent dependencies stay outside ASAR.
Tovu uses electron-builder; only its dependency-closure walk informed this script.
`@jini-ai/desktop-host` has no packaging helper and is unused by OM's desktop source.

The Coordinator must first supply one coherent build snapshot:
`corepack pnpm --filter @open-marketing/server... --filter @open-marketing/studio... --filter @open-marketing/agent... --filter @open-marketing/desktop... build`
then `corepack pnpm om:build-plugins`. Packaging consumes those outputs without rebuilding.
Download `node-v24.2.0-darwin-x64.tar.gz` and `SHASUMS256.txt` from
<https://nodejs.org/dist/v24.2.0/>. In the download directory, verify and extract:
`shasum -a 256 -c <(grep ' node-v24.2.0-darwin-x64.tar.gz$' SHASUMS256.txt)`
then `tar -xzf node-v24.2.0-darwin-x64.tar.gz`. Never supply Homebrew/system Node.

From the OM repository root:
`corepack pnpm om:package -- --node-dir /absolute/path/node-v24.2.0-darwin-x64`
Outputs: `apps/desktop/release/mac/Open Marketing.app` and
`apps/desktop/release/Open-Marketing-x64.dmg`. Staging/release are disposable and ignored.
The app bundles Node, server, agent, studio, SQL and plugin distributions outside ASAR.
State stays in `~/.open-marketing` to preserve existing data and sealed credentials.
Electron session data uses `~/Library/Application Support/Open Marketing`; the source-run
theme preference under `@open-marketing/desktop` does not carry over on the first launch.

Manual acceptance (Coordinator; use disposable state and fixtures, no live vendor calls):
- Copy the app out of the checkout; hide/rename the checkout and double-click from Finder.
- First unsigned launch: right-click → Open if macOS requires it; accept the system prompt.
- Confirm studio at `http://127.0.0.1:43120`, chat/agent reachable, and state persisted in `~/.open-marketing`.
- Quit and confirm no bundled Node server or agent process remains; relaunch to check persistence.
- On the owner's Retina + external display setup, launch from Finder without Terminal focus;
  record Displays arrangement and `osascript -e 'tell application "System Events" to tell process "Open Marketing" to get position of window 1'`.

Window hypothesis: x=-1365 (800pt width) and x=-1655 (1360pt width) both fit centering
on a left-hand ~1920pt external display. Cocoa's key-screen placement before U1 is the
likely cause; Retina pixels differ from DIP. U1 already recenters a truly off-screen
window. Minimal fix: retain U1 and verify the actual display geometry; no new bounds code.

NEEDS: Coordinator runs written fixtures, aggregate checks, packaging and acceptance.
Developer ID signing, hardened runtime/entitlements, notarization, DMG signing and
arm64/universal builds are deferred. arm64 needs ad-hoc `identity: "-"` or a real certificate.
