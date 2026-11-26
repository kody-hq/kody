# Installed package apps

Choose **Install** on a package's page to open its app in a dedicated desktop
window and add a launcher on this computer.

## Install and launch

The package page shows **Install** behind the `desktop-install-package-apps`
flag. The shell checks `/session?org=<owner>` and
[installs only when the package owner's flag is on](test/package-apps.test.cjs).
Installing a package app:

- Saves it and its remembered window bounds to the
  [local `package-apps.json` store](package-apps.cjs).
- Opens it in a [sandboxed window](package-app-windows.cjs) using the Kody
  session for the Open app handoff. The [navigation guard](package-apps.cjs)
  allows the app's origin, a new origin reached through that app's handoff, and
  Kody's handoff, sign-in, and approval pages. Other external HTTP(S) and mail
  links open in the default browser; unsupported destinations are blocked. Page
  calls to `window.open` open eligible links in the system browser instead of
  creating an Electron window ([window-open handler](package-app-windows.cjs)).
- Creates a launcher that opens `kody://app/<owner>/<package>`: an `.app` in
  `~/Applications/Kody Apps/` on macOS, a Start Menu shortcut in `Kody Apps`
  with its own AppUserModelID on Windows, and a `.desktop` entry in
  `~/.local/share/applications` on Linux. The launcher opens the app window
  rather than the dashboard.
- When the app is gone or access ends, the window offers Retry or Uninstall.

`kody://app/<owner>/<package>/<path>` opens that path in an installed app, for
launchers, notification clicks, and links. The scheme is registered from
Info.plist on macOS, from the MSIX manifest on Windows, and on first launch on
Linux. For an app that isn't installed, the
[install link handler](package-app-windows.cjs) offers the package page with
`?install=desktop` when the owner's flag is on, sign-in when signed out, or the
normal Kody window when the flag is off. In a browser, the package page's
Install dialog offers **Open in Kody** (the same `kody://` link) or **Download
Kody** through `/download`.

## Desktop bridge

The [installed app preload](package-app-preload.cjs) exposes
`window.kodyDesktopApp` after the main process accepts the window's main frame,
an allowed app origin, and the owner's cached feature flag. The
[bridge dispatcher](package-app-windows.cjs) checks those again on every call
and refreshes the flag if its cached value is at least a minute old. The bridge
exposes the following actions:

- `permissions.query(kind)` and `permissions.request(kind)` resolve `granted`,
  `denied`, or `prompt` for supported kinds and `unavailable` otherwise.
- Web `Notification`, after the
  [notification permission check](package-app-windows.cjs) accepts the grant. A
  notification created with `{ data: { path } }` focuses the app and opens that
  path when clicked.
- `badge.set(count)` (needs `notifications`), `window.show()`, `hide()`,
  `focus()`, `setFloating(on)` (needs `floating`), and `window.open(path)` for
  up to eight extra windows on the same app.
- `menuBar.set(path, { tooltip })` needs `menuBar`. `menuBar.remove()` removes
  an item set by the same origin. The path becomes a menu-bar or tray icon whose
  click toggles a popover on that page, sized by
  `<meta name="kody-menubar-size" content="360x480">`. An app with a menu-bar
  item keeps running after its window closes, and the item comes back on the
  next launch.
- `shortcuts.register(accelerator)` needs `shortcuts`; `unregister(accelerator)`
  removes a shortcut registered by the same origin. Use `onPress(callback)` to
  handle presses. Up to eight global shortcuts per app, each with a modifier and
  one key. A press opens the app if needed and calls `onPress`.
- `startAtLogin.set(on)` needs `startAtLogin`. At system login, Kody opens
  opted-in apps hidden when their grant and the owner's feature flag still
  apply.

## Manifest settings and permissions

An app can declare install settings in `kody.app.desktop` in its `package.json`:
`icon`, a path the app serves for the launcher icon, and `menuBar`,
`{ path, tooltip }` for a menu-bar page offered right after install. Kody asks
for the menu bar permission once and
[adds the item only when granted](test/package-app-permissions.test.cjs).

The [permission gate](package-app-permissions.cjs) prompts for each permission
in a native dialog and remembers the answer per app and origin in
`package-apps.json`. Reinstalling over an existing installation or reloading the
local store preserves those answers.
[Uninstalling deletes them](package-app-windows.cjs). Use the installed window's
**App** menu to change or reset permissions or uninstall. The
[bridge dispatcher](package-app-windows.cjs) accepts the installed-app actions
above and rejects unknown actions.
