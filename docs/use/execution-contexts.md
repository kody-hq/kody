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
- The operator's own runs on a context have the same Kody access as in Kody
  cloud, workflows included; anyone else's runs on a shared context use no
  credentials, start no workflows, and get `context_run_denied` from Kody APIs
  kept for Kody cloud.
- Capabilities: `executionContextList`, `executionContextGet`,
  `executionContextUpdate`, `executionContextRevoke`, `executionContextDelete`,
  `executionContextRunList`, `executionChainGet`, `executionChainSet`, and the
  sharing capabilities. Find them with `search({ query: "execution context" })`.
- CLI: `kody connect --name <name>` (register plus background service),
  `kody context register --name <name>`,
  `kody daemon install | status [--json] | logs | restart | uninstall`,
  `kody update`, `kody context policy allow <path> [--mode ro|rw]`,
  `kody daemon [--max-concurrent <n>]` (`KODY_CONTEXT_MAX_CONCURRENT`, 1 to 8,
  default 2), `kody chain show | add | remove`,
  `kody context commands [status | on | off] [--context <name>] [--json]`.

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
