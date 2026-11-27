# Execution contexts

Run `execute` and automations on your own machine instead of Kody cloud. Usage,
setup, and behavior live in the
[Execution contexts guide](../guides/execution-contexts.md)
(`search({ entity: "guide:execution_contexts" })`).

Execution contexts are an experiment. Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "execution-contexts", enabled: true })`.

## Fields

- `execute` takes `context` (id or name), `fallback: "chain"`, `chain` (up to 8
  contexts, `"cloud"` only last), and `requires: ["fs" | "lan"]`. See
  [Execute and workflows](./execute.md#execution-contexts).
- Results carry `ranOn`:
  `{ kind, id, name, attempts, fellBackToCloud, workerUnits }`. `attempts[]` is
  `{ target, name?, outcome, reason? }` for each skipped entry (`offline`,
  `busy`, `rejected`, …). `workerUnits` is 0 on a context and, on Kody cloud, 1
  only the first time that worker runs that UTC day. An in-progress cloud
  response omits it. `runGet` `metadata.ranOn` does not include it. See
  [Search and execute](../guides/search-and-execute.md).
- Automations take `execution` with the same shape plus
  `whenOffline: "fail" | "queue"` and `queueMinutes` (default 60, max 1440).
  Read and set overrides with `automationExecutionGet` /
  `automationExecutionSet`.
- Every run on a context uses the requester's own credentials exactly as in Kody
  cloud, and credentialed requests leave from Kody cloud, so credential values
  never reach the machine. `execute`'s `credentials` map is stored on the run
  lease; the machine cannot override those picks.
- The operator's own runs on a context have the same Kody access as in Kody
  cloud, workflows included. On a shared context, someone else's runs need their
  opt-in (`executionContextOptIn`, `POST /v1/execution-contexts/{id}/opt-in`, or
  the context's page). Opting in is consent: while their run is active, the
  operator's machine can use their credentials (GitHub, email and others they
  have connected) and read the responses, and the operator sees their code,
  inputs, logs and results. Without the opt-in the context is skipped
  (`not_opted_in`) and the chain falls through; a run that names the context
  without `fallback: "chain"` fails instead. Their runs start no workflows and
  get `context_run_denied` from Kody APIs kept for Kody cloud. Host folders in
  the grant stay on the operator's own runs only; shared runs do not mount them
  (`fs_operator_only` if a run `requires: ["fs"]`).
- Capabilities: `executionContextList`, `executionContextGet`,
  `executionContextUpdate`, `executionContextRevoke`, `executionContextDelete`,
  `executionContextRunList`, `executionContextRunCancel`, `executionChainGet`,
  `executionChainSet`, `executionContextNoticeDismiss`,
  `executionContextSharePreview`, and the sharing capabilities. Find them with
  `search({ query: "execution context" })`. Shared-box access notices appear
  once in execute and search `notices` (`context-elevation` for a grantee;
  `context-misconfigured` for the operator). The operator also gets
  `context-open-shell` while the machine has host commands on and the shell has
  no package list. It stays on the context page and in what is waiting on you
  until you limit the shell to listed packages, turn host commands off on the
  machine, or dismiss it with fingerprint `open-shell` to keep the shell as it
  is. On the context page the notice lists the packages and programs that used
  the shell in the last 30 days; `executionContextShellSuggestions` returns the
  same with example commands. List those packages for the shell, or define the
  programs as named commands on the machine. See
  [Shared-box best practices](../guides/execution-contexts.md#shared-box-best-practices).
- Token scopes: reads (`executionContextList`, `executionContextGet`, sharing
  and run lists, `executionChainGet`) need `execution_context:read`. Sharing
  changes (`executionContextShareSet`, `executionContextShareRemove`,
  `executionContextMachineAccessGrant`, `executionContextMachineAccessRevoke`,
  `executionContextAttach`, `executionContextDetach`) need
  `execution_context:manage_access`. `executionContextNoticeDismiss`,
  `executionChainSet`, opt-in and opt-out need `execution_context:execute`. A
  `kody login` token carries all of them; the handlers still check that you are
  the operator or hold Manage.
- CLI: `kody connect --name <name>` (register plus background service),
  `kody context register --name <name>`,
  `kody daemon install | status [--json] | logs | start | stop | restart | uninstall`,
  `kody daemon auto-update [on | off | status]` (on by default), `kody update`,
  `kody context policy allow <path> [--mode ro|rw]`,
  `kody context capability [list] | add command|lan <file.json> | remove command|lan <name>`
  (defines named commands and local network destinations on this machine and
  tells Kody their names; the operator's runs can use a named command and reach
  a named local network destination), `kody daemon [--max-concurrent <n>]`
  (`KODY_CONTEXT_MAX_CONCURRENT`, 1 to 8, default 2),
  `kody chain show | add | remove`,
  `kody context commands [status | on | off] [--context <name>] [--json]`,
  `kody context cancel-run <name> <run id>`.
- Cancel a run on a machine with `executionContextRunCancel({ id, run_id })`
  (Open API `POST /v1/execution-contexts/{id}/runs/{run_id}/cancel`). It ends
  cancelled with `cancelReason: "user_cancelled"` in run history (its run record
  is status `error`). Once execute returned an in-progress runId, closing the
  CLI or MCP client does not cancel the run; disconnecting before execute
  returns can.

## Listing machines

`executionContextList` returns one page, ordered by name (id breaks ties). Omit
`cursor` for the first page and pass `nextCursor` as `cursor` until it is
`null`. The default `limit` is 20; the maximum is 100.

`unutilized` summarizes live contexts outside your chain that you can use or opt
in to, across all pages. It does not check whether the machines are online. It
returns a count and names the contexts when there are at most three. It is
omitted when there are none.

## Registration limits

Registration counts unrevoked contexts owned by the org. The plan caps both each
person's registrations and the org total. Free uses one org-wide pool; paid
plans multiply the per-seat amount by live seats (at least one). When
registration hits a cap, revoke an unused context with
`kody context revoke <name>`.

## Auto-update

Every `kody daemon` keeps itself current: background services, a daemon in a
terminal, and the one the desktop app runs. It checks npm for a newer
`@kodycodes/cli` on start and about every 4 hours (with jitter), downloads it,
checks the npm sha512 integrity, installs it into a Kody-managed folder
(`~/.local/share/kody/cli` on Linux, `~/Library/Application Support/kody/cli` on
macOS, `%APPDATA%\kody\cli` on Windows), and proves it starts. Then it stops
taking new runs, waits for runs in flight and background host commands to finish
(at most 24 hours), and relaunches onto the new version. New runs go down the
chain meanwhile.

It never downgrades. A failed download or install keeps the old version running
and retries with backoff (1h, doubling to 24h); a new version that crashes right
after starting is skipped and the old one takes over again. Each step is logged
in the daemon log (`kody daemon logs`), including a check that found nothing
newer and a latest version that is skipped because it failed to start here.
`kody daemon health --json` reports the last check and its error; see
[liveness](#liveness-and-health-checks).

- `kody daemon auto-update status` (`--json`): on or off, the last check, the
  latest version, and recent updates. `kody daemon status` shows it too.
- `kody daemon auto-update off` / `on`: the machine-wide switch, stored as
  `autoUpdate` in `execution-context-policy.json`. Running daemons pick it up at
  their next check. `KODY_DAEMON_AUTO_UPDATE=0` turns it off for one daemon.
- The desktop app: **This machine** (in the web account menu) > the **Automatic
  updates** toggle.
- The context page shows the daemon's CLI version and whether auto-update is on.

Existing installs need nothing: a daemon started from a CLI that has auto-update
turns it on at its next restart (or run `kody update` once).

## Liveness and health checks

The daemon pings Kody every 30 seconds on every connection, including each one
it opens after a drop. No answer within 10 seconds, or a socket that stopped
without a close event, closes that connection and opens a new one. Three more
guards make a daemon that cannot recover exit nonzero, so systemd, launchd, the
Windows task, or a container restart policy starts it again:

- No working connection to Kody for 30 minutes of running time while no run is
  in flight: a daemon under a service, an update supervisor, or in a container
  logs why and exits 1. A daemon in a terminal keeps retrying, since nothing
  would start it again.
- An event loop stuck for 5 minutes: a watchdog thread kills the process.
- A machine that sleeps does not trip either one; both count running time.

`kody daemon health` reads the state file the daemon rewrites every 30 seconds,
so it needs no network and no login. It exits 0 when a daemon is running and
heard Kody within `--max-age` seconds (default 120), and 1 when no daemon runs,
the daemon is frozen, or it has been disconnected or unanswered for longer.
`--json` prints `healthy`, `reason` (`ok`, `not-running`, `no-health-data`,
`stalled`, `disconnected`, `heartbeat-stale`), `connected`, `lastHeartbeatAt`,
`lastHeartbeatAgeSeconds`, and the last auto-update check with its error.
`kody daemon status --json` carries the same object as `health` and exits 1 when
a running daemon is unhealthy.

In a container, run an init process and add the health check:

```yaml
services:
  kody:
    image: your-kody-image
    command: ['kody', 'daemon']
    init: true
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'kody', 'daemon', 'health']
      interval: 60s
      timeout: 20s
      start_period: 60s
      retries: 3
```

The Dockerfile form is
`HEALTHCHECK --interval=60s --timeout=20s --start-period=60s --retries=3 CMD kody daemon health`.

`init: true` matters: Linux ignores a kill signal that PID 1 sends itself, so
without an init process the watchdog cannot end a frozen daemon. The daemon logs
a warning when it starts as PID 1. Docker marks a failing container `unhealthy`
but does not restart it on its own; Swarm and Kubernetes do, and plain Docker or
Compose needs a watcher such as
[autoheal](https://github.com/willfarrell/docker-autoheal). Keep the CLI store
(`~/.local/share/kody/cli`, or `KODY_CLI_STORE_DIR`) on a volume so an
auto-updated version survives a recreated container.

## One runner per machine

A context runs one daemon at a time on a machine. Every launcher (the background
service, `kody daemon` in a terminal, the desktop app) takes the same runner
lock (`daemon.lock` next to `daemon.json` in the CLI config folder), so a second
daemon for the same context does not start: a terminal or desktop daemon exits
naming the one that runs it, and a service waits until the other stops. If
another daemon still replaces this one on the server (an older CLI without the
lock, or the same key on another machine), the daemon logs one explanation
naming the other process and stops instead of reconnecting in a loop.

Install the desktop app from
[kody-hq/kody-desktop releases](https://github.com/kody-hq/kody-desktop/releases/latest)
(canonical) or the shareable shortcut
[https://kody.codes/download](https://kody.codes/download). On Windows, trust
the sideloading certificate once, then open the App Installer link
([Windows install](../../packages/desktop/README.md#windows-install-and-updates)).
The desktop app and the CLI share this machine's registration and its runner:

- When `kody daemon install` set up a service, or a daemon already runs, the app
  adopts it. **This machine** shows that runner (hover the status line for its
  version), and Pause, Resume, and Restart control the service
  (`kody daemon start | stop | restart`).
- Setup offers **Use this machine's existing registration** when the CLI already
  registered this machine, instead of creating a second context. It checks first
  that the registration belongs to your account.
- In an organization, **This machine** setup keeps a team destination through
  personal registration when needed, then **Make available to @team** attaches
  that registration and puts it first in your chain there. **Manage setup** does
  the attach step when the machine is already registered personally. It does not
  register again, and your personal setup and your other entries in the
  organization's chain stay as they are. Setup resumes from the last completed
  stage and does not report success before the intended workspace lists the
  machine.
- With no service, the app runs the daemon itself, with the same lock and
  auto-update.
- On macOS, only the app's own runner can control other apps (such as Messages)
  through the app's Automation permission; see
  [macOS app control](#macos-app-control).

`kody daemon status` shows the runner holding the lock, and `kody daemon stop`
stops whichever one runs (the service, or a terminal or desktop daemon after its
runs finish). On Windows, which cannot signal another process,
`kody daemon stop` ends that daemon and its `workerd.exe` children right away;
the desktop app's own runner still drains first.

## Host commands

Host commands let runs on your machine run shell commands there: `git clone`,
`npm install`, a build, a test suite. They are off on every machine until you
turn them on at that machine.

**What turning them on means.** A run with the command grant can run anything
your user account can run on that machine, with no approval per command. It can
install software, read, change, or delete your files, and use your network.
Commands run as the user who runs `kody daemon` (or the Kody desktop app), never
as root; `sudo` behaves like it does in your own terminal (it prompts and fails,
because nobody is there to type a password). Only you get the command grant on
your own machine. People you share the machine with never get it, and their runs
get no host folders either. Every command is recorded in the machine's audit log
with the command, folder, exit code, and who ran it. Environment variable values
are never recorded, only their names, so pass secrets in `env`, never in the
command text (the command text is recorded as written).

**Turn them on (on the machine itself).**

- Desktop app: **Machine › Allow commands**, then confirm.
- CLI: `kody context commands on` (all contexts registered on this machine) or
  `kody context commands on --context <name>`.

Turning them on is only possible on the machine. The website and the API cannot
turn them on.

**Turn them off (from anywhere, takes effect right away).**

- Desktop app: uncheck **Machine › Allow commands**.
- CLI: `kody context commands off`.
- Website: the **Host commands** panel on the machine's page, **Turn off
  commands**.
- API/MCP: `executionContextUpdate` with
  `{ "grant": { "commands": { "enabled": false } } }`.

Turning them off stops background commands that runs started.

`kody context commands status` shows both switches: this machine's local opt-in
and what Kody has for each context. A command runs only when both are on.

**Platforms.** macOS, Linux, and Windows. Commands use your shell (`$SHELL`,
else `/bin/sh`) on macOS and Linux, and PowerShell on Windows (`pwsh` if
installed, else Windows PowerShell; pass `shell: 'cmd'` for `cmd.exe`).

### macOS app control

Commands that control other apps on a Mac (sending iMessages with `osascript`,
scripting Finder or Calendar) need macOS Automation permission, and reading the
Messages database (`~/Library/Messages/chat.db`) needs Full Disk Access. macOS
asks once per target app; after you allow it, runs with host commands on can use
that app without asking you again.

The Kody desktop app (0.1.5 or later) includes a Contacts entitlement. Packages
that use the macOS Contacts framework to resolve names, phone numbers, or email
addresses get a separate Contacts prompt. That consent belongs to the desktop
app's own runner, not an adopted CLI service or terminal daemon.

macOS checks the app that runs the daemon:

- **Kody desktop app runs the runner** (no CLI service or terminal daemon):
  macOS asks for **Kody**. Use desktop 0.1.4 or later for Messages Automation,
  and 0.1.5 or later for Contacts.
- **CLI service** (`kody daemon install`, a LaunchAgent) or **`kody daemon` in a
  terminal**: macOS checks that `node` binary or the terminal app, not Kody,
  even when the desktop app shows the runner as adopted. It may deny control
  without asking.

To send Messages through the Kody app on a machine with a CLI service, remove
the service but keep the registration, then let the app run the runner:

```sh
kody daemon uninstall --no-unregister
```

If a terminal `kody daemon` owns the runner instead, stop it with
`kody daemon stop`. This also keeps the registration.

Then open **This machine** in the desktop app and resume it if paused. Allow
**Kody** when macOS asks to control Messages, grant Full Disk Access to Kody in
System Settings › Privacy & Security if the run reads `chat.db`, and allow
Contacts if the run looks up names. The runner then stops when you quit the app.

**Fields.**

- Runtime: `kody.command.run`, `start`, `status`, `output`, `kill`, `list` from
  `kody:runtime`. See the
  [Execution contexts guide](../guides/execution-contexts.md#run-commands-on-the-machine).
  Saved packages (including imported community packages) can call
  `kody.command.*` too, under the same machine opt-in and grant.
- Grant: `grant.commands: { enabled, enabledAt }` on `executionContextGet`.
  `executionContextUpdate` accepts only `enabled: false`; `enabled: true` fails
  with `commands_opt_in_local`.
- Permission: `execution_context:command`. Only the operator has it, on their
  own context. `executionContextShareSet` with `commands: true` fails with
  `commands_operator_only`, and legacy command shares confer nothing. Commands
  get the daemon's environment without `KODY_*` variables and cannot use a
  credential folder as `cwd`.
- Named local network destinations: with the local network off, a run's `fetch`
  to an address and port that the machine defined with
  `kody context capability add lan` goes through once Kody allows it. The same
  rules as named commands apply (the operator or a grant, the
  `machine_capability:use` scope, the package rule), and the same errors. Only
  IP addresses match: a host name is never matched, even one that resolves to a
  listed address. Each use is audited as `lan_used` with the name, address and
  port. Egress mode `none` still refuses everything.
- Host folders have names too: `kody context policy show` lists each allowed
  folder with the name Kody knows it by (the folder's own name). The first time
  a run touches a folder, Kody is asked and records `fs_used` with that name and
  the run's packages. Folders stay for the operator's own runs.
- Named commands:
  `kody.command.run({ capability: 'kdocker', args: ['restart', 'plex'] })` (and
  `start`) runs a command the machine defined with
  `kody context capability add command`. The machine's definition fixes the
  executable, folder, environment and timeout ceiling, no shell is involved, and
  the arguments must match one of its allowed shapes. Only `args`, `timeoutMs`
  and `maxOutputBytes` are accepted. It works with the shell
  (`kody context commands`) off. The machine's operator can use one, and so can
  anyone the operator shared it with (see the next item). A token needs the
  `machine_capability:use` scope, and every saved package the run loaded
  directly must be one the operator's org wrote or adopted. Kody's audit row
  holds the name and arguments, not the executable path. Errors:
  `machine_capability_off` (the machine defines no such command),
  `machine_capability_not_granted`, `machine_capability_package_not_allowed`
  (names the packages), `machine_command_args_refused` (lists the allowed
  shapes).
- Sharing machine access: the operator shares one named command or local network
  destination with a person, a team, or everyone in the org using
  `executionContextMachineAccessGrant`
  (`{ id, kind: "command" | "lan", name, username | team_slug | everyone: true }`).
  The person also needs the context shared with them, and their runs then use it
  by name like the operator's. `executionContextMachineAccessList` shows each
  entry and who has it; `executionContextMachineAccessRevoke` takes a grant
  back, and the next use is refused. The unrestricted shell and host folders are
  never shared. The machine needs CLI 3.42.0 or later.
- Profiles: a run acting as a profile uses a named command or local network
  destination only when the profile, and every parent profile, was given it.
  Give one of your own profiles an entry you can use yourself with
  `executionContextMachineAccessGrant` and `profile_id` in place of a person
  (parents first). You take it back with `executionContextMachineAccessRevoke`.
  A profile grant never widens what you can use. A run acting as a profile can
  only pass an entry down to its own sub-profiles.
  `executionContextMachineAccessList` shows you the grants on your own profiles
  when you do not manage the machine.
- Packages: by default your own code and packages your org wrote or adopted may
  use an entry. To limit a named command, local network destination or host
  folder to chosen packages, the operator passes the full list of package ids to
  `executionContextMachineAccessPackagesSet`
  (`{ id, kind: "shell" | "command" | "lan" | "fs", name, package_ids }`; the
  unrestricted shell is kind `shell`, name `shell`, on a machine with host
  commands on). With packages listed, a run may use the entry only when every
  saved package it loaded directly is on the list, and code that is not a saved
  package may not use it. An empty list lifts the limit. This is also how you
  let a package from someone else use an entry without adopting it. The list
  never shares the entry with another person. A machine with the whole local
  network turned on also lists it, as kind `lan`, name `*`, and each run's first
  use of a local address and port is audited as `lan_used`. It cannot be shared.
  You can limit it to packages once the machine runs Kody CLI 3.44.0 or newer;
  Kody refuses the list on an older machine, which would not check it. The list
  covers local addresses and `localhost` and `.local` names, not other host
  names that resolve to a local address, so define named destinations for a
  strict limit.
- In the app: a context's detail page has a Machine access section that lists
  its named commands, local network destinations and host folders with who holds
  each one, and any package limit. The operator gives or takes back access
  there. Someone the machine is shared with sees the entries their own profiles
  hold and can give one of their profiles an entry. Host folders are listed as
  operator only.
- A saved package the run loaded directly must declare each named command and
  local network destination it uses in
  [`kody.machine`](./packages.md#machine-access-kodymachine). Otherwise the call
  fails with `machine_need_undeclared`, which names the package and the JSON to
  add. Code that is not a saved package declares nothing. For host folders a
  missing declaration is recorded and does not fail the run yet.
- Errors: `execution_context_commands_off` (the machine has not opted in),
  `execution_context_command_not_granted` (the caller lacks the command grant),
  `execution_context_command_requires_context` (the run is in Kody cloud or a
  `--local` run).
