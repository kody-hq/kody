---
id: execution_contexts
title: Execution contexts
summary:
  Run execute on your own machine with kody connect. The daemon runs as a
  background service on Linux (systemd) and macOS (launchd), survives reboots
  and crashes, and stops for good when you revoke the context.
category: platform
---

# Execution contexts

An execution context is a machine of yours (a laptop, a home server, a build
box) that runs `execute` for you instead of Kody cloud. The feature is behind
the `execution-contexts` experiment; turn it on from the Execution contexts page
in your account.

## Connect a machine

On the machine that should run code:

```sh
npm install -g @kodycodes/cli
kody login
kody connect --name my-machine
```

`kody connect` registers the machine (the key is generated there and never
leaves it) and installs `kody daemon` as a background service, so it starts at
login or boot and restarts after a crash. Pass `--org <slug>` to register it in
a team org, `--no-install` to skip the service, or `--yes` to accept the
defaults without prompts. Already registered with `kody context register`? Run
`kody daemon install`.

Install the CLI globally. The service refuses to run from `npx`, `pnpm dlx` or
`bunx` because those copies are deleted after the command ends.

## Manage the service

| Command                                        | What it does                                            |
| ---------------------------------------------- | ------------------------------------------------------- |
| `kody daemon status` (`--json`)                | Names each problem with the command that fixes it       |
| `kody daemon logs` (`--lines <n>`, `--follow`) | Shows the daemon log                                    |
| `kody daemon restart`                          | Restarts after in-flight runs finish                    |
| `kody daemon install`                          | Installs, or repairs an existing service                |
| `kody daemon uninstall` (`--unregister`)       | Removes the service, and optionally revokes the context |
| `kody update`                                  | Installs the latest CLI and restarts services onto it   |

- **Linux** uses a `systemd --user` unit. To keep it running while you are
  logged out (or before you log in after a reboot), enable linger once:
  `sudo loginctl enable-linger "$(id -un)"`. `kody daemon status` tells you when
  it is off.
- **macOS** uses a per-user LaunchAgent, so it runs while you are logged in.
- **Windows** is not supported yet. Keep `kody daemon` running in a terminal.

The service never runs as root and holds no API token or passphrase. It
authenticates with the machine key, which a background service cannot unlock
with a prompt. When the key needs a passphrase, or Linux has no unlocked
keyring, install offers a file key instead: a random key stored next to the
encrypted machine key with permissions 600 (`--key-storage file`).

## Daemon version and service status

The context detail page shows the daemon's CLI version, flags it when a newer
`@kodycodes/cli` is out (run `kody update` on the machine), and says whether it
runs as a background service or in a terminal.

## Revoke

`kody context revoke <name>` or Revoke on the context page stops the daemon for
good: it does not reconnect, and the background service disables itself instead
of restarting. Remove the leftover service with `kody daemon uninstall`, or
connect again with `kody connect --name <name>`.
