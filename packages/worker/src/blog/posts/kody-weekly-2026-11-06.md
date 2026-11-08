---
title: Kody weekly: Local secret reads, an Apps page, and profiles
date: 2026-11-06
description: Local secret reads, an Apps page, usage warnings, and 6 more features, plus fixes and 2 dated credential changes.
order: 1
category: updates
---

Here is what shipped in Kody from October 31 to November 6, 2026. This week the
CLI can read secrets on your machine with consent and a record of every read,
your org gets an Apps page, usage gets easier to see and control, and team orgs
get finer controls. Execution contexts and profiles, two early access
experiments, also grew a lot. Two credential changes have dates coming up: see
Breaking changes below.

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

## An Apps page for every workspace

### What shipped

Every workspace now has an Apps page at `/@your-org/-/apps` that lists your
hosted package apps with search, sorting, and icon, card, and list views.
Members can find apps shared with them even without access to the package.

### Why it matters

Apps were spread across package pages. Now there is one place to find and open
every app you can use.

### Example

Open `https://kody.codes/@your-org/-/apps`, search for an app by name, and
switch to the list view to sort them.

Docs: [Package apps](https://kody.codes/docs/package-apps) · PR:
[#4734](https://github.com/kody-hq/kody/pull/4734)

## Usage warnings you can see and control

### What shipped

Every `execute` response now reports the worker units it charged. Once a month,
when your org crosses 80% of its Worker compute include, the response carries a
heads-up. Ad hoc usage is split by connection, so you can tell which assistant
used the units. Owners can turn off usage warning emails and the heads-up from a
Usage warnings panel in **Organization settings**, and searching for "turn off
usage warnings" finds that setting.

### Why it matters

You and your agent see what a run cost while it happens, before a bill surprises
you, and you can quiet the warnings if you do not want them.

### Example

Run any `execute` call and read the worker units in the response, then open
**Organization settings** and find the Usage warnings panel.

Docs: [Platform efficiency](https://kody.codes/docs/platform-efficiency) · PRs:
[#4695](https://github.com/kody-hq/kody/pull/4695),
[#4703](https://github.com/kody-hq/kody/pull/4703),
[#4715](https://github.com/kody-hq/kody/pull/4715)

## Team org controls: who creates, org-wide Manage, and team deletion

### What shipped

Team org Owners can now choose whether Members can create packages and apps (off
by default) and whether they can create credentials (on by default). Creators
keep full access to what they make. Owners can also grant Manage on every
package and app in the org at once, including ones created later. Anyone with
`team:write` can delete a team: its slug becomes reusable, and grants and audit
history are kept.

### Why it matters

Owners decide how open the org is, hand a lead Manage across everything without
one grant per package, and clean up old teams without losing the record of what
they did.

### Example

1. Open your team org's Settings and turn on **Members can create packages and
   apps**.
2. Grant a teammate org-wide Manage for packages and apps.
3. Delete a team you no longer use and check that its history is still in the
   audit log.

Docs: [Organizations](https://kody.codes/docs/organizations) · PRs:
[#4623](https://github.com/kody-hq/kody/pull/4623),
[#4587](https://github.com/kody-hq/kody/pull/4587),
[#4752](https://github.com/kody-hq/kody/pull/4752),
[#4788](https://github.com/kody-hq/kody/pull/4788)

## Share a private package's source with a Read preset

### What shipped

A new Read preset shares a private package's source with one person, even
someone outside your org. They can read it and fork it into their own Kody, but
they cannot run your package or open its app.

### Why it matters

You can show someone how a package works, or let them start their own copy,
without giving them your package's credentials or spend.

### Example

On a private package's Collaborators tab, add a person with the **Read** preset.
They open the package, read the source, and choose Fork.

Docs: [Package sharing](https://kody.codes/docs/package-sharing) · PR:
[#4663](https://github.com/kody-hq/kody/pull/4663)

## Try Kody before you sign up

### What shipped

The sign-in screen your agent opens now has **Try it out**. Someone without an
account gets a guest account right away, and can claim it later without
reconnecting the agent.

### Why it matters

New people can see what Kody does with their own agent before they make an
account, and nothing is lost when they decide to keep it.

### Example

1. Connect your agent to Kody and choose **Try it out** on the sign-in screen.
2. Use Kody from your agent as a guest.
3. Claim the account when you are ready. The agent stays connected.

PRs: [#4848](https://github.com/kody-hq/kody/pull/4848),
[#4860](https://github.com/kody-hq/kody/pull/4860)

## Sign in from limited browsers

### What shipped

`/login` and `/verify` now accept a normal form post and redirect, so you can
sign in from an e-reader's built-in browser or with JavaScript turned off.
Package app Open links offer "Sign in on another device" for the rest. Modern
browsers keep the in-page experience.

### Why it matters

Kody apps work on devices like Kindles, where a script-heavy sign-in page never
finished.

### Example

Open a package app link on an e-reader, choose "Sign in on another device," and
approve the sign-in from your phone.

Docs: [Limited browser sign-in](https://kody.codes/docs/limited-browser-sign-in)
· PRs: [#4666](https://github.com/kody-hq/kody/pull/4666),
[#4706](https://github.com/kody-hq/kody/pull/4706),
[#4817](https://github.com/kody-hq/kody/pull/4817)

## Execution contexts on your own machines (early access)

### What shipped

Execution contexts are an early access experiment that you turn on at
`/account/experiments`. They run `execute` and automations on your own machine
or a build server instead of Kody cloud. This week:

- `kody daemon` installs as a per-user background service (`systemd --user` on
  Linux, `launchd` on macOS, Task Scheduler on Windows), so a context survives
  reboots, and daemons update themselves.
- Windows is a supported platform for the daemon and the desktop runner.
- A daemon run can execute shell commands on the machine, behind two switches
  that are both off by default: a local opt-in and a separate
  `execution_context:command` grant.
- Runs on your machine use the same credential narrowing, grants, and package
  capabilities as runs in Kody cloud. Credentials stay in Kody cloud.
- A Kody desktop app signs in through your browser, keeps a registered machine
  available, and ships signed updates. A guided setup in the web app walks you
  through sign-in, machine registration, and your execution chain.
- Revoked machines can be deleted, and runs can be canceled from the CLI, API,
  MCP, or website.

### Why it matters

Builds, local folders, and devices on your network are reachable from Kody runs
without moving your credentials off Kody cloud.

### Example

After turning on the experiment:

```sh
kody connect
kody daemon status
kody context commands on
```

Docs: [Execution contexts](https://kody.codes/docs/execution-contexts) · PRs:
[#4638](https://github.com/kody-hq/kody/pull/4638),
[#4660](https://github.com/kody-hq/kody/pull/4660),
[#4662](https://github.com/kody-hq/kody/pull/4662),
[#4627](https://github.com/kody-hq/kody/pull/4627),
[#4652](https://github.com/kody-hq/kody/pull/4652),
[#4659](https://github.com/kody-hq/kody/pull/4659),
[#4631](https://github.com/kody-hq/kody/pull/4631),
[#4690](https://github.com/kody-hq/kody/pull/4690),
[#4686](https://github.com/kody-hq/kody/pull/4686),
[#4685](https://github.com/kody-hq/kody/pull/4685)

## Profiles give agents their own identity (early access)

### What shipped

Profiles are an early access experiment at `/account/experiments`. A profile is
an identity an agent acts as in an org, with its own grants, an optional expiry,
and revocation. Profiles chain into sub-profiles with narrower access, a token
can be bound to a profile, and expiry is capped by the earliest limit in the
chain. One call creates a sub-profile and mints its token for a sub-agent. A new
profiles page shows your profiles as a tree.

### Why it matters

A bot or sub-agent does not have to act as you. It gets only the access you hand
it, and everything it does is attributed to its profile.

### Example

Turn on the experiment, create a profile for a bot with read access to one
package, mint a token for it with `tokenCreate` and its `profile_id`, and check
the profiles page for the new entry.

Docs: [Profiles](https://kody.codes/docs/profiles) · PRs:
[#4624](https://github.com/kody-hq/kody/pull/4624),
[#4661](https://github.com/kody-hq/kody/pull/4661),
[#4668](https://github.com/kody-hq/kody/pull/4668),
[#4688](https://github.com/kody-hq/kody/pull/4688)

## More updates

- **Platform:** Adds an experiments catalog at `/account/experiments` with a
  summary, stage, guide link, and switch for each experiment.
  ([#4629](https://github.com/kody-hq/kody/pull/4629),
  [#4644](https://github.com/kody-hq/kody/pull/4644),
  [#4646](https://github.com/kody-hq/kody/pull/4646))
- **Memory:** Makes `search` surface a memory only when it is relevant to the
  query, instead of always showing the top two.
  ([docs](https://kody.codes/docs/memory),
  [#4870](https://github.com/kody-hq/kody/pull/4870))
- **CLI:** Makes local execute time out on a limit you can set, runs
  `kody execute --local ./file.ts` like `--file`, and reports every missing
  scope at once. ([docs](https://kody.codes/docs/local-execute),
  [#4767](https://github.com/kody-hq/kody/pull/4767))
- **CLI:** Uses one credential resolver for every command, so `kody whoami`
  reports the credential `kody api` sends.
  ([#4651](https://github.com/kody-hq/kody/pull/4651))
- **Billing:** Bills an internal package app visit to the visiting member's org
  instead of the host org. ([#4669](https://github.com/kody-hq/kody/pull/4669))
- **Packages:** Makes publish size errors name `.kodyignore` and list the
  largest files. ([docs](https://kody.codes/docs/publish-large-packages),
  [#4640](https://github.com/kody-hq/kody/pull/4640))
- Plus smaller changes, including a one-click Fork button
  ([#4907](https://github.com/kody-hq/kody/pull/4907)) and a Copy prompt button
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

- Update the CLI, turn on **Local reads** for one secret, and run
  `kody run --secret databaseUrl -- npm test`.
- Open your workspace's Apps page at `/@your-org/-/apps`.
- Turn on an experiment at `/account/experiments` and follow its guide.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
