# 0093: Execution-context runs can run host commands after a local opt-in

- **Status:** accepted
- **Date:** 2026-10-30
- **Amends:** [0083](./0083-context-runs-never-see-credential-values.md) (adds a
  capability to the machine; credential values still stay in Kody cloud)

## Context

A run on an execution context ran sealed in the daemon's workerd isolate: no
`child_process`, host files only through folder grants, no chmod or symlinks. An
agent could not `git clone`, `npm install`, and build on Kent's Mac through
Kody, while desktop agents like Grok can run commands on the user's machine.

## Decision

Kent decided on 2026-10-30:

1. **One opt-in per machine, made on the machine.** Host commands are off for
   every existing and new context. `kody context commands on` or the desktop
   app's **Machine › Allow commands** turns them on; that sets the local policy
   and calls a route signed by the machine key. No API, MCP, or website path
   turns them on. Off works from the machine, the website, and
   `executionContextUpdate`, and takes effect immediately.
2. **The daemon's user, never root.** Commands run as the OS user running the
   daemon. No sudo handling: sudo prompts or fails as it would in their
   terminal.
3. **A grant, `execution_context:command`.** The operator has it on their own
   context. Shares get it only when granted explicitly (`commands: true`);
   presets and everyone-in-the-org sharing leave it out. It is an ordinary
   permission so profiles can withhold it later.
4. **`kody.command.*` in `kody:runtime`.** `run` returns bounded stdout and
   stderr, exit code, signal, and duration. `start`, `status`, `output` (offset
   chunks), `kill`, and `list` manage background jobs held by the daemon, so
   builds outlive the 90 second run window. Chunked polling, not streaming,
   because it fits the request/response runtime bridge and the ECP frames.
5. **Same as other machine runs.** Execute, scheduled, triggered, and app-visit
   runs on the context use it the same way. Busy and offline fallback stay as
   they are; a cloud fallback fails command calls with
   `execution_context_command_requires_context`. Denials name the missing piece:
   `execution_context_commands_off` or `execution_context_command_not_granted`.
6. **Audited, env values redacted.** Every start (`command_started`, through the
   CapabilityProxy authorize hop) and finish (`command_finished`, through a
   signed `command.finished` frame) lands in the context audit log with command,
   cwd, exit code, context, and caller; env keys only.
7. **macOS and Linux.** Windows refuses before spawning.

## Consequences

- Turning commands on gives anyone with the grant the machine user's full power.
  The docs say so in plain words; the website and desktop show the state.
- Rejected: per-command approval (Kent wants no prompts after the one opt-in);
  remote opt-in (a stolen token must not be enough to get a shell); running
  commands inside workerd (it has no process API).
- Revisit if profiles need per-command allowlists, or when Windows gets a
  runner.
