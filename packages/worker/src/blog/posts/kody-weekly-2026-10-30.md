---
title: Kody weekly: Package apps run as their publisher
date: 2026-10-30
description: Package apps use the publisher's credentials and spend, plus 7 more updates to Activity, invites, the CLI, and forks, and 3 breaking changes.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from October 24 to October 30, 2026. This week
package apps run as the person who published them, Activity shows who started
each run, and the CLI can sign in from machines without a local browser. Three
changes need action: see Breaking changes below.

## Package apps run as their publisher

### What shipped

A hosted package app now runs as its publisher. The publisher pays for the app,
and the publisher's credentials fill the app's needs. Visitors bring only a
verified identity, and Sign in with Kody lets an app use a visitor's own data
with one consent scope per need. Each app also gets its own cookies, its own
rate limits, and a per-visitor spend view.

### Why it matters

You can share an app with people outside your org without asking each of them to
connect the same accounts first. You stay in control of what it costs, and
visitors choose what of their own data the app can use.

### Example

Publish a package app that calls an integration you have connected, open it in a
private window as a visitor, and check the per-visitor spend on the package page
afterward.

Docs: [Package apps](https://kody.codes/docs/package-apps) · PRs:
[#4278](https://github.com/kody-hq/kody/pull/4278),
[#4351](https://github.com/kody-hq/kody/pull/4351)

## More updates

- **Execute:** Records who started each run, and from which client, and shows it
  in Activity. ([#4309](https://github.com/kody-hq/kody/pull/4309))
- **Orgs:** Adds labels, default teams, and last used times to shareable org
  invite links, and lets agents create them.
  ([docs](https://kody.codes/docs/organizations),
  [#4385](https://github.com/kody-hq/kody/pull/4385))
- **CLI:** Adds `kody login --device` for signing in from a machine whose
  browser cannot reach the CLI.
  ([#4434](https://github.com/kody-hq/kody/pull/4434))
- **Community:** Adds a Forks page for every package that shows the forks you
  can open, and lets you choose an org for one-click installs.
  ([#4401](https://github.com/kody-hq/kody/pull/4401),
  [#4423](https://github.com/kody-hq/kody/pull/4423))
- **Packages:** Adds a New repository button to the Repositories page.
  ([#4409](https://github.com/kody-hq/kody/pull/4409))
- **Email:** Adds spam and archive triage for every inbox, without deleting
  messages. ([#4323](https://github.com/kody-hq/kody/pull/4323))
- **Automations:** Saves why a job is off and shows it on the job, and records
  manual job runs in the org audit log.
  ([#4248](https://github.com/kody-hq/kody/pull/4248),
  [#4381](https://github.com/kody-hq/kody/pull/4381))

## Fixes

- **Apps:** Tightens package app cookie handling.
  ([#4419](https://github.com/kody-hq/kody/pull/4419))

## Breaking changes

- **Apps:** Package apps no longer run as their visitor. **Action:** check that
  your own credentials cover your app's needs, and use Sign in with Kody where
  the app needs a visitor's data.
  ([#4278](https://github.com/kody-hq/kody/pull/4278))
- **Automations:** `once` job schedules are removed. **Action:** schedule
  delayed one-time work with `workflows.create` and `runAt` instead.
  ([#4310](https://github.com/kody-hq/kody/pull/4310))
- **Packages:** Package retrievers are removed, and search no longer runs
  package code. **Action:** delete `kody.retrievers` from your `package.json`.
  ([#4313](https://github.com/kody-hq/kody/pull/4313))

## Try it

On a remote machine, run `kody login --device` and enter the code it prints in
your browser.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
