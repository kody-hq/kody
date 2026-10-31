# Execution contexts

Run `execute` and automations on your own machine instead of Kody cloud. Usage,
setup, and behavior live in the
[Execution contexts guide](../guides/execution-contexts.md)
(`search({ entity: "guide:execution_contexts" })`).

Execution contexts are an experiment. Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "execution-contexts", enabled: true })`.

## Fields

- `execute` takes `context` (id or name), `fallback: "chain"`, `chain` (up to 3
  contexts, `"cloud"` only last), and `requires: ["fs" | "lan"]`. See
  [Execute and workflows](./execute.md#execution-contexts).
- Results carry `ranOn`: `{ kind, id, name, attempts, fellBackToCloud }`.
  `attempts[]` is `{ target, name?, outcome, reason? }` for each skipped entry
  (`offline`, `busy`, `rejected`, …).
- Automations take `execution` with the same shape plus
  `whenOffline: "fail" | "queue"` and `queueMinutes` (default 60, max 1440).
  Read and set overrides with `automationExecutionGet` /
  `automationExecutionSet`.
- Every run on a context uses the requester's own credentials exactly as in Kody
  cloud, and credentialed requests leave from Kody cloud, so credential values
  never reach the machine.
- The operator's own runs on a context have the same Kody access as in Kody
  cloud, workflows included. On a shared context, someone else's runs need their
  opt-in (`executionContextOptIn`, `POST /v1/execution-contexts/{id}/opt-in`, or
  the context's page). Opting in is consent: while their run is active, the
  operator's machine can use their credentials (GitHub, email and others they
  have connected) and read the responses, and the operator sees their code,
  inputs, logs and results. Without the opt-in the context is skipped
  (`not_opted_in`) and the chain falls through; a run that names the context
  without `fallback: "chain"` fails instead. Their runs start no workflows and
  get `context_run_denied` from Kody APIs kept for Kody cloud.
- Capabilities: `executionContextList`, `executionContextGet`,
  `executionContextUpdate`, `executionContextRevoke`, `executionContextDelete`,
  `executionContextRunList`, `executionContextRunCancel`, `executionChainGet`,
  `executionChainSet`, and the sharing capabilities. Find them with
  `search({ query: "execution context" })`.
- CLI: `kody connect --name <name>` (register plus background service),
  `kody context register --name <name>`,
  `kody daemon install | status [--json] | logs | start | stop | restart | uninstall`,
  `kody daemon auto-update [on | off | status]` (on by default), `kody update`,
  `kody context policy allow <path> [--mode ro|rw]`,
  `kody daemon [--max-concurrent <n>]` (`KODY_CONTEXT_MAX_CONCURRENT`, 1 to 8,
  default 2), `kody chain show | add | remove`,
  `kody context commands [status | on | off] [--context <name>] [--json]`,
  `kody context cancel-run <name> <run id>`.
- Cancel a run on a machine with `executionContextRunCancel({ id, run_id })`
  (Open API `POST /v1/execution-contexts/{id}/runs/{run_id}/cancel`). It ends
  cancelled with `cancelReason: "user_cancelled"` in run history (its run record
  is status `error`). Once execute returned an in-progress runId, closing the
  CLI or MCP client does not cancel the run; disconnecting before execute
  returns can.

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
in the daemon log (`kody daemon logs`).

- `kody daemon auto-update status` (`--json`): on or off, the last check, the
  latest version, and recent updates. `kody daemon status` shows it too.
- `kody daemon auto-update off` / `on`: the machine-wide switch, stored as
  `autoUpdate` in `execution-context-policy.json`. Running daemons pick it up at
  their next check. `KODY_DAEMON_AUTO_UPDATE=0` turns it off for one daemon.
- The desktop app: **This machine** (in the web account menu) > Turn off / Turn
  on automatic updates.
- The context page shows the daemon's CLI version and whether auto-update is on.

Existing installs need nothing: a daemon started from a CLI that has auto-update
turns it on at its next restart (or run `kody update` once).

## One runner per machine

A context runs one daemon at a time on a machine. Every launcher (the background
service, `kody daemon` in a terminal, the desktop app) takes the same runner
lock (`daemon.lock` next to `daemon.json` in the CLI config folder), so a second
daemon for the same context does not start: a terminal or desktop daemon exits
naming the one that runs it, and a service waits until the other stops. If
another daemon still replaces this one on the server (an older CLI without the
lock, or the same key on another machine), the daemon logs one explanation
naming the other process and stops instead of reconnecting in a loop.

The desktop app and the CLI share this machine's registration and its runner:

- When `kody daemon install` set up a service, or a daemon already runs, the app
  adopts it. **This machine** shows that runner and its version, and Pause,
  Resume, and Restart control the service
  (`kody daemon start | stop | restart`).
- Setup offers **Use this machine's existing registration** when the CLI already
  registered this machine, instead of creating a second context. It checks first
  that the registration belongs to your account.
- With no service, the app runs the daemon itself, with the same lock and
  auto-update.

`kody daemon status` shows the runner holding the lock, and `kody daemon stop`
stops whichever one runs (the service, or a terminal or desktop daemon after its
runs finish).

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
your own machine. People you share the machine with get it only if you share it
with `commands: true`. Every command is recorded in the machine's audit log with
the command, folder, exit code, and who ran it. Environment variable values are
never recorded, only their names, so pass secrets in `env`, never in the command
text (the command text is recorded as written).

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

**Platforms.** macOS and Linux. Windows refuses (`kody context commands on`
fails, and the desktop menu item is disabled), because the runner does not
support Windows yet.

**Fields.**

- Runtime: `kody.command.run`, `start`, `status`, `output`, `kill`, `list` from
  `kody:runtime`. See the
  [Execution contexts guide](../guides/execution-contexts.md#run-commands-on-the-machine).
- Grant: `grant.commands: { enabled, enabledAt }` on `executionContextGet`.
  `executionContextUpdate` accepts only `enabled: false`; `enabled: true` fails
  with `commands_opt_in_local`.
- Permission: `execution_context:command`. The operator has it on their own
  context. `executionContextShareSet` with `commands: true` adds it to a share;
  presets and everyone-in-the-org sharing never include it.
- Errors: `execution_context_commands_off` (the machine has not opted in),
  `execution_context_command_not_granted` (the caller lacks the command grant),
  `execution_context_command_requires_context` (the run is in Kody cloud or a
  `--local` run).
