---
title: Kody weekly: Turn your personal org into a team org
date: 2026-10-23
description: Convert a personal org into a team org, plus 7 more updates to the CLI, OAuth, package apps, and credentials.
order: 1
placeholder: false
---

Here is what shipped in Kody from October 17 to October 22, 2026. This week you
can turn a solo project into a team org, restore a deleted org, and sign the CLI
in with a real OAuth flow.

## Turn your personal org into a team org

### What shipped

From account settings you can now convert your personal org into a team org. The
team org keeps the current handle, packages, webhooks, email, and plan. Kody
creates a new free personal org with a new username for you, and moves your
personal surfaces with it. Deleted orgs also get a **Restore** button during
their restore window.

### Why it matters

Projects that start with one person often pick up collaborators. Converting
keeps the URLs and automations people already use, so you can invite a teammate
without moving packages by hand.

### Example

1. Open your account settings and choose to convert your personal org.
2. Pick the username for your new personal org and confirm.
3. Invite teammates to the team org from its members page.

Docs: [Organizations](https://kody.codes/docs/organizations) · PRs:
[#3953](https://github.com/kody-hq/kody/pull/3953),
[#3950](https://github.com/kody-hq/kody/pull/3950)

## More updates

- **CLI:** Runs a proper OAuth flow for `kody login` and mints a revocable
  device token. ([#3940](https://github.com/kody-hq/kody/pull/3940))
- **Credentials:** Connects integrations that support OAuth device
  authorization. ([#3980](https://github.com/kody-hq/kody/pull/3980))
- **Apps:** Serves hosted package apps at `{user}.kody.run/{name}`, while old
  `/packages/{name}` URLs keep working.
  ([docs](https://kody.codes/docs/package-apps),
  [#4096](https://github.com/kody-hq/kody/pull/4096))
- **Credentials:** Separates Disconnect, which clears a credential's value, from
  Delete. ([#4098](https://github.com/kody-hq/kody/pull/4098))
- **Orgs:** Lets you choose your permanent username before your account is
  created. ([#4151](https://github.com/kody-hq/kody/pull/4151))
- **Orgs:** Adds Hermes Agent as a supported agent.
  ([#3954](https://github.com/kody-hq/kody/pull/3954))
- **Dashboard:** Rolls out the new Kody koala mark across the web app.
  ([#4157](https://github.com/kody-hq/kody/pull/4157))

## Fixes

- **Automations:** Fixes Run now overwriting a package job's storage context,
  and webhook deliveries with an `Idempotency-Key` being dropped after a retry.
  ([#4147](https://github.com/kody-hq/kody/pull/4147),
  [#4144](https://github.com/kody-hq/kody/pull/4144))
- **CLI:** Fixes `kody dev check` so it runs the same publish checks as the
  server. ([#4127](https://github.com/kody-hq/kody/pull/4127),
  [#4146](https://github.com/kody-hq/kody/pull/4146))
- **Dashboard:** Fixes the account sidebar rail jumping on short lists.
  ([#4010](https://github.com/kody-hq/kody/pull/4010))
- **CLI:** Tightens local dev server request checks.
  ([#3969](https://github.com/kody-hq/kody/pull/3969))

## Try it

Run `kody login` in your terminal and approve the sign-in in your browser to get
a revocable device token for the CLI.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
