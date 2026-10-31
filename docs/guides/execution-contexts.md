---
id: execution_contexts
title: Execution contexts
summary:
  Run execute and automations on your own laptop or build server instead of Kody
  cloud. Credentials stay in Kody cloud; the machine adds host folders, LAN, and
  (after a local opt-in) shell commands via kody.command.run /
  kody.command.start with the execution_context:command grant. An experiment you
  turn on at /account/experiments.
category: platform
audience: agents
---

# Execution contexts

An execution context is a machine you run code on: your laptop, a home server,
or a build box. Run `kody connect` there and `execute`, jobs, webhooks, and
other automations can run on that machine instead of Kody cloud. Kody cloud is
always there as the fallback.

Use one when code needs something only a machine has: a folder on disk, a device
on your local network, or a tool installed there.

> [!NOTE] Execution contexts are an experiment, off until you turn them on at
> [Experiments](https://kody.codes/account/experiments). An agent can turn them
> on for you with `experimentSet` (see How to turn it on below).

## What changes on a machine

A run on your machine has the same permissions and credentials as the same run
on Kody cloud: the same token scopes, credential picks, package capabilities,
org grants, Kody APIs, and workflows (a nested `execute` runs on Kody cloud).
The context's runtime allowlist, if you set one, narrows what runs on it may
call. Three things are added, and only when you allow them:

- **Host folders.** Folders you allow with `kody context policy allow` (and that
  the context's grant includes) are mounted for the run.
- **Local network.** With egress set to `public-and-lan`, the run can reach
  devices on your network.
- **Host commands.** After you turn them on at the machine, runs with the
  command grant can run shell commands there (see
  [Run commands on the machine](#run-commands-on-the-machine)).

Credentials stay in Kody cloud and never reach the machine. When code on your
machine calls a service with a credential, that request leaves from Kody cloud,
which adds the credential on the way out. The machine sees the response, not the
credential.

## Set up a machine

1. Turn the experiment on ([How to turn it on](#how-to-turn-it-on)).
2. Install the CLI and sign in on the machine:

   ```sh
   npm install -g @kodycodes/cli
   kody login
   ```

3. Register the machine, give it a name, and install the daemon as a background
   service so it keeps running after reboots and crashes:

   ```sh
   kody connect --name my-laptop
   ```

   `kody connect` is `kody context register` plus `kody daemon install`. Pass
   `--no-install` to skip the service and run `kody daemon` in a terminal
   instead, or `--yes` to accept the defaults without prompts.

4. Optional: allow folders runs may use (read-only unless you pass `rw`):

   ```sh
   kody context policy allow ~/projects --mode rw
   ```

   On Windows use native paths, for example
   `kody context policy allow C:\Users\you\projects --mode rw`. Runs see the
   same paths (`C:\...` or `C:/...`, and UNC shares like `\\server\share`);
   matching ignores case.

5. Add it to your chain so runs go there first:

   ```sh
   kody chain add my-laptop
   ```

The machine shows up under **Execution contexts** in your workspace
(`/@<you>/-/execution-contexts`), where you can see its status, its runs, and
the chain.

## Keep it running: the background service

`kody daemon install` (run by `kody connect`) installs a per-user service for
the context, so the daemon starts at login or boot and restarts after a crash:

- **Linux:** a `systemd --user` unit. To keep it running while you are logged
  out, and to start it at boot before you log in, enable linger once:
  `sudo loginctl enable-linger "$(id -un)"`. Kody prints that command instead of
  running it.
- **macOS:** a per-user LaunchAgent, so it runs while you are logged in.
- **Windows:** a per-user Task Scheduler task (`\Kody\kody-daemon-<ecid>`) that
  starts at your logon. No administrator rights, no Windows Service. It runs
  hidden and restarts the daemon after a crash. Windows on Arm runs the x64
  runtime under emulation.

| Command                                        | What it does                                         |
| ---------------------------------------------- | ---------------------------------------------------- |
| `kody daemon status` (`--json`)                | Names each problem with the command that fixes it    |
| `kody daemon logs` (`--lines <n>`, `--follow`) | Shows the daemon log                                 |
| `kody daemon restart`                          | Restarts after runs in flight finish                 |
| `kody daemon start` / `stop`                   | Starts or stops the service (or the running daemon)  |
| `kody daemon install`                          | Installs the service, or repairs it                  |
| `kody daemon uninstall` (`--unregister`)       | Removes the service and offers to revoke the context |
| `kody daemon auto-update on\|off\|status`      | Auto-update switch for every daemon on this machine  |
| `kody update`                                  | Installs the latest CLI and moves services onto it   |

Install the CLI globally (`npm install -g @kodycodes/cli`). The service refuses
to run from `npx`, `pnpm dlx`, or `bunx`, because those copies are deleted.

The service never runs as root and holds no API token or passphrase: it signs in
with the machine key. A background service cannot answer a passphrase prompt, so
when the key needs one, or Linux has no unlocked keyring, install offers a file
key instead: a random key stored next to the encrypted machine key, readable
only by you (`--key-storage file`). On Windows the OS keyring is Windows
Credential Manager, which a logon task can use, so the keyring stays the
default; the file key fallback is protected by your user profile's folder
permissions (Windows ignores POSIX modes).

Daemons auto-update by default: on start and about every 4 hours each daemon
(service, terminal, or desktop app) checks npm, installs the verified newer
`@kodycodes/cli` into a Kody-managed folder, waits for runs in flight and
background host commands to finish, and relaunches onto it. It never downgrades,
keeps the old version when an update fails, and logs each step.
`kody daemon auto-update off` (or **This machine** in the desktop app) turns it
off on that machine; see
[execution contexts](../use/execution-contexts.md#auto-update).

The context page shows the daemon's CLI version, whether auto-update is on,
flags it when a newer `@kodycodes/cli` is out (run `kody update` on the
machine), and says whether it runs as a background service or in a terminal.

One runner per machine: the service, a terminal `kody daemon`, and the desktop
app share one lock per context, so a second daemon refuses (a service waits)
instead of replacing the first in a loop. The desktop app adopts an existing
service and registration instead of starting or registering a second one; see
[one runner per machine](../use/execution-contexts.md#one-runner-per-machine).

Revoking a context stops its daemon for good: it does not reconnect, and the
service disables itself instead of restarting. Remove the leftover service with
`kody daemon uninstall`.

## Worker compute on a machine

A run on an execution context does not use your Worker compute allowance: the
code runs in workerd on your machine, not in a Kody cloud Dynamic Worker. When a
run falls back to Kody cloud, it counts like any other cloud run (one unit the
first time that worker runs on a UTC day). Anything the run calls that runs on
Kody cloud, such as a nested `execute`, counts on Kody cloud.

## The chain and cloud fallback

Your chain is the ordered list of places Kody tries for your runs, up to three
contexts, with Kody cloud last. For each run Kody walks the chain and uses the
first entry that can take it. An entry is skipped when it is offline, busy, you
lost access to it, or it lacks what the run `requires`. When no context can take
the run, it runs on Kody cloud.

A run can also pick where it goes:

- `context: "my-laptop"` runs there and does not fall back. Add
  `fallback: "chain"` to fall back to your chain instead of failing.
- `chain: ["my-laptop", "build-box", "cloud"]` uses that order for this run. A
  chain without `"cloud"` is strict: it fails instead of using Kody cloud.
- `requires: ["fs"]` or `requires: ["lan"]` skips Kody cloud and any context
  without host folders or LAN.

## Busy machines

The machine decides how many runs it takes at once:
`kody daemon --max-concurrent <n>` or the `KODY_CONTEXT_MAX_CONCURRENT`
environment variable, from 1 to 8 (default 2). A shared context's grant can
lower that limit for other people but never raise it.

When every slot is taken, the machine is busy, and busy works like offline: the
run moves to the next chain entry or Kody cloud. A run that named one `context`
without `fallback: "chain"` fails instead, with an error that says to retry when
a run finishes or pass `fallback: "chain"`.

## Where a run ran: `ranOn`

Every routed `execute` result carries `ranOn` (in MCP `structuredContent`, CLI
`--json` output, and run records):

```json
{
	"kind": "context",
	"id": "ec_…",
	"name": "my-laptop",
	"attempts": [{ "target": "ec_…", "name": "build-box", "outcome": "busy" }],
	"fellBackToCloud": false,
	"workerUnits": 0
}
```

`workerUnits` is how many Worker compute units this call charged, and the text
line says it too: `Ran on my-laptop (your machine), 0 worker units.`

`attempts` lists every entry Kody skipped and why (`offline`, `busy`, …).
`fellBackToCloud: true` means no context could take the run and it ran on Kody
cloud. Automation runs record the same `ranOn` on their run records.

## Cancel a run

Stop a run on a machine before it finishes:

- CLI: `kody context cancel-run <name|ec id> <run id>`
- MCP / capabilities: `executionContextRunCancel({ id, run_id })`
- Open API: `POST /v1/execution-contexts/{id}/runs/{run_id}/cancel`
- Website: **Cancel** next to an in-progress run in the context's **Runs**
  table.

A running run is stopped on the machine; a queued run is dropped before it runs.
In `executionContextRunList` it ends `cancelled` with
`cancelReason: "user_cancelled"`, next to the other reasons such as `deadline`
(the time limit) or `revoked`. Its run record (`runGet`) ends with status
`error` and the message "The run was cancelled (user_cancelled).". You can
cancel your own runs; people who manage the context can cancel anyone's run on
it. Cancelling a run that already ended returns `cancelled: false` with its
state, so retrying is safe.

Once execute has handed back an in-progress run id, closing the CLI or MCP
client does not cancel it: the run keeps going and its result stays readable
with `runGet`. Cancel it explicitly instead. (Disconnecting while execute is
still waiting for the result, before it returns, can still cancel the run.) Runs
on Kody cloud cannot be cancelled this way.

## Run commands on the machine

With host commands on, code in a run on the machine calls `kody.command.*` from
`kody:runtime`. Commands run as the user running the daemon, in a real shell
(`$SHELL -c`, else `/bin/sh -c`), with that user's `PATH` and tools. On Windows
the shell is PowerShell (`pwsh`, else `powershell.exe`, UTF-8 output); pass
`shell: 'cmd'` for `cmd.exe`. `file` resolves through `PATH`/`PATHEXT`, so
`{ file: 'npm', args: ['test'] }` runs `npm.cmd`, and every kill ends the whole
process tree.

```ts
import { kody } from 'kody:runtime'

const result = await kody.command.run({
	command: 'git status --short && npm test',
	cwd: '/Users/me/code/app', // absolute, must exist
	env: { CI: '1' }, // added to the daemon's environment
	timeoutMs: 120_000, // default 60 s, max 15 min
})
// { commandId, exitCode, signal, timedOut, stdout, stderr,
//   stdoutTruncated, stderrTruncated, durationMs }
```

- `command` is shell text. To skip the shell, pass `file` and `args` instead
  (`{ file: 'git', args: ['clone', url] }`).
- `stdin` (string, up to 5 MB) is written to the command, then closed.
- Output keeps the last `maxOutputBytes` of each stream (default 256 KB, max 4
  MB); `stdoutTruncated` says when earlier bytes were dropped.
- A non-zero exit is a result, not an error. Errors are for denials and bad
  input.

Builds outlive a run's timeout, so start them in the background and poll:

```ts
const job = await kody.command.start({
	command: 'npm ci && npm run build',
	cwd: '/Users/me/code/app',
})
// later, in this or another run on the same machine:
const page = await kody.command.output({
	commandId: job.commandId,
	stdoutOffset: 0, // pass back the returned offsets to read the next chunk
	stderrOffset: 0,
})
// { state, exitCode, stdout, stderr, stdoutOffset, stderrOffset, done, ... }
await kody.command.status({ commandId: job.commandId })
await kody.command.kill({ commandId: job.commandId }) // SIGTERM, then SIGKILL
await kody.command.list() // your background commands on this machine
```

Background commands run for up to `timeoutMs` (default 2 hours, max 24 hours),
keep the last 4 MB of each stream, and live in the daemon, so they keep running
after the run that started them ends. Up to 16 run at once. Only the person who
started one can read or kill it. Restarting the daemon or turning commands off
stops them.

When a command cannot run, the error names what is missing:

| Code                                         | Meaning                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `execution_context_commands_off`             | The machine has not turned host commands on                                                  |
| `execution_context_command_not_granted`      | You lack `execution_context:command` on this context, or the run's token scopes leave it out |
| `execution_context_command_requires_context` | The run is in Kody cloud (including fallback) or a `--local` run                             |

Busy and offline machines fall back the same way as other runs. A run that fell
back to Kody cloud gets `execution_context_command_requires_context` from
`kody.command.*`, so pin `context` without `fallback` when the code needs
commands. Scheduled, triggered, and app-visit runs routed to the machine use
commands the same way as `execute`.

Turn host commands on with `kody context commands on` or **Machine › Allow
commands** in the Kody desktop app. Only the machine can turn them on; turn them
off from the machine, the website, or `executionContextUpdate` with
`{ "grant": { "commands": { "enabled": false } } }`. Every command start and
finish is in `executionContextAuditList` (`command_started`, `command_finished`)
with the command, folder, exit code, and caller. Environment values are never
recorded. See [Host commands](../use/execution-contexts.md#host-commands) for
the security trade-off in plain words.

## Sharing a context

You can share a context with people or teams in your org. Their runs use the
grant you set (host folders, egress, limits). Someone you share with can use the
context only after they opt in to it: the "Opt into <name>?" dialog on the
context's page, `executionContextOptIn` (`executionContextOptOut` to leave), or
`POST /v1/execution-contexts/{id}/opt-in` (from the CLI,
`kody api executionContextOptIn`). Until then the context is skipped for their
runs (`not_opted_in`) and the run moves down their chain; a run that names the
context without `fallback: "chain"` fails instead.

Opting in is their consent, and the opt-in notice says so: while their run is
active, the operator's machine can make Kody API calls as them (within the Kody
API access its grant allows), use their credentials (GitHub, email and any
others they've connected) and read the responses, and change the results their
run returns. Their runs use their own credentials exactly as in Kody cloud, and
the credential values stay in Kody cloud and never reach the machine. Their runs
cannot start workflows there, and Kody APIs kept for Kody cloud refuse them
(`context_run_denied`). The context's runtime allowlist narrows their runs too.

Shares never include host commands unless you say so: share with
`commands: true` (`executionContextShareSet`) to give someone
`execution_context:command`. The `use`, `contribute`, and `manage` presets and
sharing with everyone in the org leave it out.

## Automations

Jobs, webhooks, subscriptions, and package workflow steps can choose where they
run with an `execution` setting of the same shape: `context` (with optional
`fallback: "chain"`) or their own `chain`, plus `requires`. Set it in the
package manifest (`kody.jobs.<name>.execution`, `kody.webhooks[].execution`,
`kody.subscriptions.<topic>.execution`) or override it with
`automationExecutionSet` or in the UI. An override wins over the manifest;
`{ context: "cloud" }` pins an automation to Kody cloud.

By default an automation whose target is offline or busy fails. With
`whenOffline: "queue"`, a later reachable entry in the chain, Kody cloud
included, takes the run. The run waits for the machine (for `queueMinutes`,
default 60, up to 1440) only when nothing later in the chain can take it. Before
a queued run starts, Kody checks access, the grant, and the flag again.

## How to turn it on

Pick one:

- **Experiments page.** Go to
  [kody.codes/account/experiments](https://kody.codes/account/experiments) and
  turn on **Execution contexts**. The **Execution contexts** link in your
  workspace navigation, marked _Experiment_, leads to the same switch.
- **Ask your agent.** Over Kody MCP, `experimentList` shows every experiment and
  whether it is on; `experimentSet` with
  `{ "experiment": "execution-contexts", "enabled": true }` turns it on for you.
- **CLI.** When it is off, `kody context`, `kody chain`, and `kody daemon` print
  the link above and stop.

Turn it off the same way. It is only for your account.

## Related

- [Execute field reference](../use/execute.md) for `context`, `chain`,
  `fallback`, and `requires`
- [Execution contexts field reference](../use/execution-contexts.md)
- [Local CLI execute](./local-execute.md), which runs code on your machine for
  one call without a daemon
