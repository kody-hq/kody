# Kody desktop

A thin Electron shell that loads https://kody.codes/account and supervises the
existing CLI execution context daemon. Website releases update the UI without a
desktop release. Published desktop releases automatically update the shell and
its bundled CLI.

```sh
npm install
npm run desktop:dev
```

After normal onboarding, the desktop app offers to set up this machine:

1. **Continue in browser** opens the CLI browser login for your personal
   workspace. The desktop verifies that it matches the account signed into the
   website.
2. Choose a machine name and select **Enable this machine**. This registers the
   device, starts its runner, and puts it first in your personal execution
   chain. Other entries keep their order and cloud fallback keeps its current
   setting. A full chain asks which existing entry to replace.
3. **Not now** skips the wizard for this account on this installation. Open
   **This machine** in the web account menu to return to setup, pause or resume
   execution, or forget this app’s setup. These controls appear only in desktop.

On macOS, closing all windows keeps the runner available. Quit stops the CLI and
its workerd processes. On Windows and Linux, closing all windows quits the app.
Pausing persists across launches. Sleep and network reconnects use the CLI's
reconnect behavior, a sleeping machine cannot run compute. A running process is
not necessarily connected, the website shows the context's status.

Keys, credentials, grants, and host-folder policy stay owned by the CLI. The
shell saves the context ID, name, account, enabled state, and onboarding
choices. Desktop explicitly selects the browser login with
`KODY_CREDENTIAL_SOURCE=login`, without changing API tokens used by terminal
commands. Signing out or switching accounts stops the previous account’s runner.
It does not delete CLI credentials or revoke the device. Forgetting desktop
setup stops the runner and clears only this app’s selection. Revoke the context
on the website to remove its access. Older registrations require browser login
and an ownership check before reuse.

The website has no Node access. A sandboxed preload exposes a versioned
navigation and fixed machine-action bridge only to the main Kody document. The
website renders Back, Forward, Home, and a page-address menu only when this
bridge is present. These controls overlay the upper-left corner. The sidebar and
sign-in branding reserve space for them, while the main panel keeps the full
window height. The bridge exposes no CLI, filesystem, or arbitrary IPC access.
Off-site links open in the system browser, except the website’s social sign-in
providers, which stay in the sandboxed window so callbacks keep its session.
Providers may impose their own embedded-browser restrictions. Device
registration and runner controls are rendered by the website through fixed,
authenticated shell actions. Browser permissions are denied by default. The
shell bundles the workspace CLI and runs it in a separate process using
Electron's Node runtime, without needing Node or a global CLI on PATH. Native
Node-API dependencies keep their normal Node build, not an Electron rebuild.

## Platform support

The shell targets macOS, Windows, and Linux. Local execution currently supports
**macOS and Linux on x64 or arm64**, matching the CLI's pinned workerd
downloads. Windows machine setup is disabled until the CLI supports a Windows
execution runtime. Native Apple app access is not part of this wrapper, it needs
specific permissioned capabilities.

## Host commands

**This machine > Allow host commands** opens a native confirmation explaining
that granted runs can execute any shell command as your user, without approval
per command. It uses the CLI's `context commands on|off --context <ecid>`.
Turning it off stops background commands too. The website and CLI can also turn
it off, and the controls refresh while the machine panel is open. Commands are
disabled on Windows and before setup. See
[Host commands](../../docs/use/execution-contexts.md#host-commands).

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
The separate Desktop release workflow signs, notarizes, verifies, and publishes
production installers once release credentials are configured. Application files
are unpacked so CLI chunks, Node-API modules, and native executables have normal
filesystem paths.

The smoke check needs a graphical desktop and the live website. To check a
packaged build, pass its executable after `--`, for example:

```sh
npm run test:smoke --workspace @kodycodes/desktop -- ../../artifacts/desktop/mac-arm64/Kody.app/Contents/MacOS/Kody
```

It opens the live sign-in page, checks renderer isolation and the machine
bridge, and runs the bundled CLI with Electron’s Node runtime. It does not sign
in, register a real device, or change an execution chain.

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
seconds, attempts after five minutes. Cancel and Quit close the listener. The
listener answers with a self-contained branded page (`callback-page.cjs`: inline
CSS and Kody mark, a hash-pinned CSP, light and dark themes) that confirms
sign-in or explains the failure with a retry hint. It never echoes the code,
state, or session. A callback with the matching state and an OAuth-style `error`
ends the attempt right away (`access_denied` shows a canceled page). Older
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

The machine setup checks are separate from live enrollment:

```sh
npm run test:execution-ui --workspace @kodycodes/desktop
npm run test:execution-shell --workspace @kodycodes/desktop -- <local-origin>
```

The first uses fixture native actions and server functions to exercise the real
wizard, including onboarding order, skipping, full-chain replacement, and retry.
The second verifies the real Electron bridge, signed-in local account,
native-only controls, and saved dismissal. Neither enrolls a real production
machine.

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
before opening it. Artifacts expire after 30 days. This workflow uploads test
artifacts only. The Desktop release workflow publishes production downloads and
the update feed.

CI builds are unsigned, and macOS builds are not notarized. Production signing
credentials belong in the release environment described below. Windows
installers work on x64 and arm64, but the local execution runner remains
disabled on Windows.

To build the same native installers locally:

```sh
npm run build --workspace @kodycodes/cli
npm run dist --workspace @kodycodes/desktop
npm run test:packaged-cli --workspace @kodycodes/desktop
```

The packaged CLI check also accepts an absolute output directory after `--` when
using a separate local packaging directory.

## Production releases and updates

Desktop downloads and updates live in the public `kody-hq/kody-desktop`
repository. This keeps the update feed separate from the website's daily
releases. Users do not need a GitHub token. Every architecture has its own
update manifest so parallel jobs cannot overwrite another architecture's feed.

Production apps check on launch and every five minutes, download automatically,
and install on Quit. **Updates > Restart to update** quits and relaunches with
the downloaded version. Both paths stop the local runner before installing.
Closing a Mac window continues to keep the app and runner open. Update failures
retry without interrupting the app. Development builds never check for updates.
Updates do not downgrade or install prereleases.

Run **Desktop release** manually on main after bumping the desktop package
version and lockfile. The default `mac` scope builds Apple silicon and Intel Mac
installers without requiring a Windows signing account. Choose `all` to add
Windows and Linux later. Once those platforms have been published, future
releases must keep choosing `all` so their update feeds stay available. Every
selected build must succeed before publishing. macOS builds require Developer ID
signing, Apple's notarization service, and a valid stapled ticket. Windows
builds require valid signatures on the application and installer. The final job
uploads all installers, blockmaps, manifests, and checksums to a draft, then
publishes it. Published versions cannot be replaced. The normal Desktop binaries
workflow still produces unsigned CI artifacts.

A repository admin must create the `desktop-release` GitHub environment in
`kody-hq/kody` and restrict its deployment branches to main. The first Mac
release needs the five Apple secrets and publishing token below. Windows
certificate secrets and the Windows publisher variable are only required for
`all` releases.

| Secret                                 | Value                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `DESKTOP_MAC_CERTIFICATE_BASE64`       | Base64 Developer ID Application `.p12`, including its private key            |
| `DESKTOP_MAC_CERTIFICATE_PASSWORD`     | Password protecting that export                                              |
| `DESKTOP_APPLE_API_KEY_BASE64`         | Base64 App Store Connect `.p8` key authorized for notarization               |
| `DESKTOP_APPLE_API_KEY_ID`             | Apple API key ID                                                             |
| `DESKTOP_APPLE_API_ISSUER`             | Apple API issuer ID                                                          |
| `DESKTOP_WINDOWS_CERTIFICATE_BASE64`   | Base64 Windows signing `.pfx`, including its private key                     |
| `DESKTOP_WINDOWS_CERTIFICATE_PASSWORD` | Password protecting that export                                              |
| `DESKTOP_RELEASE_TOKEN`                | Fine-grained token with Contents write access only to `kody-hq/kody-desktop` |

Set the environment variable `DESKTOP_WINDOWS_PUBLISHER` to the exact Windows
certificate publisher name. Keep signing identities stable, existing installs
verify replacement signatures.

For Azure Artifact Signing (formerly Trusted Signing), set
`DESKTOP_WINDOWS_SIGNING_PROVIDER=azure` instead of supplying the Windows
certificate secrets. Set environment variables `DESKTOP_AZURE_ENDPOINT`,
`DESKTOP_AZURE_ACCOUNT`, and `DESKTOP_AZURE_PROFILE`, plus secrets
`DESKTOP_AZURE_TENANT_ID`, `DESKTOP_AZURE_CLIENT_ID`, and
`DESKTOP_AZURE_CLIENT_SECRET`. The service principal needs the
[Artifact Signing Certificate Profile Signer role](https://learn.microsoft.com/azure/artifact-signing/tutorial-assign-roles)
on a Public Trust certificate profile. Publisher name must match the profile
certificate. The default `certificate` provider uses the `.pfx` secrets above.

Upload credentials through GitHub's environment secrets UI or use the CLI's
interactive prompt, for example:

```sh
gh secret set DESKTOP_MAC_CERTIFICATE_PASSWORD --env desktop-release --repo kody-hq/kody
```

Enter the value at the prompt. Do not put keys or passwords in chat, source
files, or release notes. The local Mac's Developer ID identity is not available
on GitHub runners until a protected export is configured there.

For a local Mac production build, `CSC_NAME` can select the existing Developer
ID identity in Keychain without exporting its private key. Provide
`APPLE_API_KEY` as the local `.p8` path, plus `APPLE_API_KEY_ID` and
`APPLE_API_ISSUER`. CI still requires the protected certificate export above.

The existing 0.1.0 demo predates the updater. Install the first production
release manually once, subsequent releases update automatically. A real
signed-version-to-signed-version update remains part of first-release
acceptance.
