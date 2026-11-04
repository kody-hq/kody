---
title: Kody weekly: Anyone can sign up for Kody
date: 2026-09-11
description: Signup is open with no waitlist or invite, plus 7 more updates to docs, referrals, agents, email, and packages, and 1 breaking change.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from September 5 to September 11, 2026. This week
signup opens to everyone, the guides become a docs site at `/docs`, and you can
earn Standard time by referring friends or connecting a second agent. One change
needs action: see Breaking changes below.

## Anyone can sign up for Kody

### What shipped

The waitlist and invite-only gates are gone. There is one signup path: create an
account, verify your email, and connect your agent. Invite codes are removed
along with them.

### Why it matters

You no longer need an invite to try Kody or to bring a teammate. Send them the
homepage and they can be connected to their agent in a few minutes.

### Example

1. Create an account at kody.codes and verify your email.
2. Follow [Connect your agent](https://kody.codes/docs/connect-your-agent) for
   your MCP client.
3. Ask your agent to `search` Kody for what it can do with email.

PRs: [#2211](https://github.com/kody-hq/kody/pull/2211),
[#2221](https://github.com/kody-hq/kody/pull/2221)

## More updates

- **Docs:** Turns guides into a docs site at `/docs` with a grouped sidebar, a
  [Search and execute](https://kody.codes/docs/search-and-execute) guide, and
  permalink anchors on headings.
  ([#2189](https://github.com/kody-hq/kody/pull/2189),
  [#2208](https://github.com/kody-hq/kody/pull/2208),
  [#2247](https://github.com/kody-hq/kody/pull/2247))
- **Billing:** Adds an uncapped referral program that gives you and your
  referral one Standard month each after their first paid invoice, and a 14-day
  Standard trial when you connect a second agent.
  ([#2129](https://github.com/kody-hq/kody/pull/2129),
  [#2122](https://github.com/kody-hq/kody/pull/2122))
- **Orgs:** Lists every connected agent on your account, grouped by name with
  logos. ([#2119](https://github.com/kody-hq/kody/pull/2119),
  [#2136](https://github.com/kody-hq/kody/pull/2136))
- **Community:** Turns `/@username` into a public catalog of your packages, and
  renders relative images in package READMEs.
  ([#2064](https://github.com/kody-hq/kody/pull/2064),
  [#2167](https://github.com/kody-hq/kody/pull/2167))
- **Email:** Lets you delete stored messages and inboxes, and release a former
  email address after you change your login email.
  ([#2186](https://github.com/kody-hq/kody/pull/2186),
  [#2106](https://github.com/kody-hq/kody/pull/2106))
- **Credentials:** Adds a `/connect/secrets` page for approving a secret's
  hosts. ([#2076](https://github.com/kody-hq/kody/pull/2076))
- **Docs:** Adds a guide that explains how packages, integrations, and MCP
  servers differ, and an official package apps guide.
  ([docs](https://kody.codes/docs/packages-integrations-mcp),
  [#2045](https://github.com/kody-hq/kody/pull/2045),
  [#2183](https://github.com/kody-hq/kody/pull/2183))

## Fixes

- **Orgs:** Fixes username changes on your profile snapping back after Save.
  ([#2113](https://github.com/kody-hq/kody/pull/2113))
- **Credentials:** Tightens how webhook URL secrets and secret approvals are
  handled. ([#2213](https://github.com/kody-hq/kody/pull/2213))

## Breaking changes

- **Packages:** Publishing a package now requires a `README.md` for people and
  an `AGENTS.md` for agents. **Action:** add both files before your next
  publish. ([docs](https://kody.codes/docs/package-authoring),
  [#2116](https://github.com/kody-hq/kody/pull/2116))

## Try it

Send a teammate your referral link from your account, and open
[the docs](https://kody.codes/docs) to find the guide for your next package.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
