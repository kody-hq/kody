---
title: Kody weekly: Read your secrets locally with the Kody CLI
date: 2026-11-06
description: kody secret get and kody run read secrets on your own machine, plus 7 more updates, 8 fixes, and 2 dated credential changes.
order: 1
category: updates
---

Here is what shipped in Kody from October 31 to November 6, 2026. This week the
CLI can read secrets on your machine with consent and a record of every read,
your org gets an Apps page, and usage gets easier to see and control. Two
credential changes have dates coming up: see Breaking changes below.

## Read your secrets locally with the Kody CLI

### What shipped

Two new CLI commands read a Kody secret's value on your own machine.
`kody secret get` prints a value (raw by default, or `--format env` and
`--format json` for several), and `kody run --secret` runs a command with
secrets in its environment. A secret is readable only after someone with write
access turns on **Local reads** on its page, and every read is recorded in that
secret's Local reads list with the device that read it. `kody secret get`
refuses to print to an interactive terminal unless you pass `--reveal`; piped
output works as is.

### Why it matters

Local tools and agent-run scripts need values like a database URL, and copying
them into dotfiles hides who uses them. Now the value stays in Kody, the same
access checks apply, and you can see every machine that read it. Agents need a
token that allows local reads, so an agent token does not get this by accident.

### Example

Turn on **Local reads** for a secret named `databaseUrl`, then:

```sh
kody login
kody secret get databaseUrl --format env --reveal
kody run --secret databaseUrl -- npm run migrate
```

Docs: [Secrets](https://kody.codes/docs/secrets) · PRs:
[#4922](https://github.com/kody-hq/kody/pull/4922),
[#4923](https://github.com/kody-hq/kody/pull/4923)

## More updates

- **Apps:** Adds an Apps page to every workspace (`/@your-org/-/apps`) that
  lists your hosted package apps with search, sorting, and icon, card, and list
  views. Members can find apps shared with them even without access to the
  package. ([docs](https://kody.codes/docs/package-apps),
  [#4734](https://github.com/kody-hq/kody/pull/4734))
- **Billing:** Shows the worker units each `execute` call charged, adds a
  once-a-month heads-up in the `execute` response when your org passes 80% of
  its Worker compute include, splits Ad hoc usage by connection, and lets an
  Owner turn off usage warnings in **Organization settings**.
  ([docs](https://kody.codes/docs/platform-efficiency),
  [#4695](https://github.com/kody-hq/kody/pull/4695),
  [#4703](https://github.com/kody-hq/kody/pull/4703),
  [#4715](https://github.com/kody-hq/kody/pull/4715))
- **Packages:** Adds a Read preset so you can share a private package's source
  with one person, even outside your org, and they can fork it into their own
  Kody without running your package or opening its app.
  ([docs](https://kody.codes/docs/package-sharing),
  [#4663](https://github.com/kody-hq/kody/pull/4663))
- **Orgs:** Lets team-org Owners choose whether Members can create packages and
  apps (off by default) and credentials (on by default), grant Manage on every
  package and app in the org at once, and delete a team without losing its
  history. ([docs](https://kody.codes/docs/organizations),
  [#4623](https://github.com/kody-hq/kody/pull/4623),
  [#4752](https://github.com/kody-hq/kody/pull/4752),
  [#4788](https://github.com/kody-hq/kody/pull/4788))
- **Orgs:** Adds **Try it out** to the sign-in screen your agent opens, so
  someone without an account gets a guest account right away and can claim it
  without reconnecting. ([#4848](https://github.com/kody-hq/kody/pull/4848))
- **Memory:** Makes `search` surface a memory only when it is relevant to the
  query, instead of always showing the top two.
  ([docs](https://kody.codes/docs/memory),
  [#4870](https://github.com/kody-hq/kody/pull/4870))
- **CLI:** Makes local execute time out on a limit you can set, runs
  `kody execute --local ./file.ts` like `--file`, and reports every missing
  scope at once. ([docs](https://kody.codes/docs/local-execute),
  [#4767](https://github.com/kody-hq/kody/pull/4767))
- Plus smaller changes, including plain HTML sign-in for limited browsers
  ([#4666](https://github.com/kody-hq/kody/pull/4666),
  [#4817](https://github.com/kody-hq/kody/pull/4817)), a one-click Fork button
  ([#4907](https://github.com/kody-hq/kody/pull/4907)), and a Copy prompt button
  on error pages ([#4910](https://github.com/kody-hq/kody/pull/4910)). See the
  [full release list](https://github.com/kody-hq/kody/releases).

## Fixes

- **Packages:** Fixes large packages passing or failing typecheck on the same
  unchanged tree. ([#4731](https://github.com/kody-hq/kody/pull/4731))
- **Packages:** Fixes publishes that failed with a bare `internal_error`,
  stopped partway, or blocked a retry of the same commit.
  ([#4658](https://github.com/kody-hq/kody/pull/4658),
  [#4645](https://github.com/kody-hq/kody/pull/4645),
  [#4730](https://github.com/kody-hq/kody/pull/4730))
- **Platform:** Fixes "Worker exceeded memory limit" errors caused by large
  packages. ([#4797](https://github.com/kody-hq/kody/pull/4797))
- **Execute:** Fixes long hosted `execute` runs that stayed `running` for
  minutes instead of ending with a timeout message.
  ([#4765](https://github.com/kody-hq/kody/pull/4765))
- **Credentials:** Fixes a reconnected integration losing its new tokens to a
  refresh that was already running, and a failing login credential retrying its
  provider over and over. ([#4641](https://github.com/kody-hq/kody/pull/4641),
  [#4653](https://github.com/kody-hq/kody/pull/4653))
- **Automations:** Fixes edits made to a job while **Run now** executes being
  reverted when the run finishes.
  ([#4630](https://github.com/kody-hq/kody/pull/4630))
- **Credentials:** Fixes website credential changes so they require Write on
  that credential. ([#4626](https://github.com/kody-hq/kody/pull/4626))
- **Platform:** Fixes: tightens session and input handling.
  ([#4733](https://github.com/kody-hq/kody/pull/4733))

## Breaking changes

- **Credentials:** From November 30, a credential's non-empty allowed-packages
  list also applies to packages you authored or adopted. **Action:** if a
  package of yours is refused, approve it on the secret's page (the error links
  to it). ([docs](https://kody.codes/docs/secrets),
  [#4235](https://github.com/kody-hq/kody/pull/4235))
- **Credentials:** `secretJwtSign` calls with neither an https `aud` nor
  `send_to_host` are refused for new callers after November 10 and for everyone
  from December 2. **Action:** pass `send_to_host` with the host the JWT is sent
  to. ([#4763](https://github.com/kody-hq/kody/pull/4763),
  [#4794](https://github.com/kody-hq/kody/pull/4794))

## Try it

Update the CLI, turn on **Local reads** for one secret, and run
`kody run --secret databaseUrl -- npm test`.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
