# Kody desktop

A thin Electron shell that loads https://kody.codes/account and supervises the
existing CLI execution context daemon. Website releases update the UI without a
desktop release. Shell and CLI automatic updates are planned, not implemented.

```sh
npm install
npm run desktop:dev
```

In the **Machine** menu:

1. **Sign in to CLI…** opens the normal CLI browser login. The website session
   and CLI login are separate. Existing CLI credentials are reused.
2. Enable **Execution context experiment** on the website if needed.
3. **Register this machine…** shows the CLI identity before registering under a
   lowercase name based on the computer's hostname. On macOS and Linux, this
   also starts the daemon.
4. Open **Execution contexts** and add the machine to your chain if you want it
   used by default. Registration alone never changes routing.

**Stop runner** stops accepting compute and stays stopped after reopening.
**Start runner** enables it again, including on subsequent launches. On macOS,
closing all windows keeps the runner available, and Quit stops the CLI and its
workerd processes. On Windows and Linux, closing all windows quits the app.
Sleep and network reconnects use the CLI's reconnect behavior, a sleeping
machine cannot run compute. **Runner details…** shows bounded in-memory CLI
output. A running process is not necessarily connected, the website shows the
context's status.

Keys, credentials, grants, and host-folder policy stay owned by the CLI. The
shell saves only the context id and whether to start it. Website logout does not
sign out the CLI or revoke a device. Use **Stop runner** to stop compute, or
revoke the context on the website to remove its access. Forgetting a desktop
registration only clears the shell's selection.

The website has no Node access. A sandboxed preload exposes a versioned
navigation bridge only to the main Kody document. The website renders Back,
Forward, Home, and a page-address menu only when this bridge is present. These
controls overlay the upper-left corner. The sidebar and sign-in branding reserve
space for them, while the main panel keeps the full window height. The bridge
exposes no CLI, filesystem, or arbitrary IPC access. Off-site links open in the
system browser, except the website’s social sign-in providers, which stay in the
sandboxed window so callbacks keep its session. Providers may impose their own
embedded-browser restrictions. Device registration and runner controls are
native menu actions. Browser permissions are denied by default. The shell
bundles the workspace CLI and runs it in a separate process using Electron's
Node runtime, without needing Node or a global CLI on PATH. Native Node-API
dependencies keep their normal Node build, not an Electron rebuild.

## Platform support

The shell targets macOS, Windows, and Linux. Local execution currently supports
**macOS and Linux on x64 or arm64**, matching the CLI's pinned workerd
downloads. Windows registration is available, but starting the runner is
disabled until the CLI supports a Windows execution runtime. Native Apple app
access is not part of this wrapper, it needs specific permissioned capabilities.

## Packaging and checks

```sh
npm run desktop:validate
npm run desktop:pack
npm run test:smoke --workspace @kodycodes/desktop
npm run validate
```

Packaging produces an unpacked app under `artifacts/desktop/` for the current
platform. Build each platform on its own CI host. The Desktop binaries workflow
builds installers for macOS, Windows, and Linux on native x64 and arm64 runners.
Signing, notarization, release publishing, and automatic shell/CLI updates still
need release configuration. Application files are unpacked so CLI chunks,
Node-API modules, and native executables have normal filesystem paths.

The smoke check needs a graphical desktop and the live website. To check a
packaged build, pass its executable after `--`, for example:

```sh
npm run test:smoke --workspace @kodycodes/desktop -- ../../artifacts/desktop/mac-arm64/Kody.app/Contents/MacOS/Kody
```

It opens the live sign-in page, checks renderer isolation and the Machine menu,
and runs the bundled CLI with Electron’s Node runtime. It does not sign in,
register a real device, or change an execution chain.

For local UI development, start the website with control-kody, then run
`npm start --workspace @kodycodes/desktop -- --app-url=http://localhost:3743`
using the origin printed by control-kody. The override accepts only loopback
origins in unpackaged builds. Production builds always load the live site. The
integrated controls require the website release containing the desktop
navigation component.

The website advertises `X-Kody-Desktop-Navigation: 1` on HTML responses. On
macOS the shell checks that capability before hiding the native titlebar, so
older website releases and offline launches retain usable window controls. The
web UI and shell can ship independently.

After `control-kody login --origin <local-origin>`, run
`npm run test:explorer --workspace @kodycodes/desktop -- <local-origin>`. It
verifies sign-in navigation, same-document history, Home, address copying, macOS
window close/reopen without stopping the runner, and the absence of desktop
controls in a regular browser.

Browser sign-in is the default when the website advertises
`X-Kody-Desktop-Authentication: 1`. Continue in your browser opens the system
default browser, reuses its normal login/signup flow, and asks for approval. A
random loopback listener accepts the one-time code, and the main process redeems
it with an S256 verifier before installing the HttpOnly app session. The
verifier and session never enter renderer JavaScript. Codes expire after 90
seconds, attempts after five minutes. Cancel and Quit close the listener. Older
websites and shells keep the existing embedded sign-in form.

The website release includes migration `0215-desktop-browser-login.sql` and must
ship before the shell enables browser authentication on the live site. CLI
sign-in still grants the CLI its own scoped credentials through its existing
browser flow. A website session does not become a CLI API token.

Run
`npm run test:browser-login --workspace @kodycodes/desktop -- <local-origin>`
after local control-kody login. It uses isolated profiles, approves the
disposable local browser session, verifies the native workspace signs in, and
checks wrong-verifier and replay rejection without opening your real browser.

## CI binaries

The **Desktop binaries** workflow runs on main and pull requests when desktop,
CLI, shared code, or dependency manifests change. It can also be run manually
from GitHub Actions. Each OS and architecture builds on a matching runner.

Each job builds the workspace CLI, runs desktop tests, builds the installer, and
runs that packaged Electron executable in Node mode to check its CLI and native
keyring binding. The check does not read or write stored credentials.

Download the artifacts from the workflow run. They contain macOS DMG and ZIP
files, Windows NSIS installers, or Linux AppImages, with architecture-specific
filenames, SHA-256 checksums, and build metadata identifying the source commit.
On Linux, install your distribution's FUSE 2 compatibility library
(`libfuse2t64` on Ubuntu 24.04), then make the downloaded AppImage executable
before opening it. Artifacts expire after 30 days. The workflow uploads
artifacts only, it does not publish GitHub releases or enable automatic app
updates.

CI builds are unsigned, and macOS builds are not notarized. Signing credentials
are not configured in this repository. Windows installers work on x64 and arm64,
but the local execution runner remains disabled on Windows.

To build the same native installers locally:

```sh
npm run build --workspace @kodycodes/cli
npm run dist --workspace @kodycodes/desktop
npm run test:packaged-cli --workspace @kodycodes/desktop
```

The packaged CLI check also accepts an absolute output directory after `--` when
using a separate local packaging directory.
