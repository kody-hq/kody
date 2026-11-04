---
title: Kody weekly: Manage your organization on the web
date: 2026-10-16
description: Org settings and members pages under /@slug/-/, plus 7 more updates to triggers, credentials, MCP servers, and packages.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from October 10 to October 16, 2026. This week team
orgs get settings and members pages on the web, every trigger runs as the person
who turned it on, and credentials get one page for every kind.

## Manage your organization on the web

### What shipped

Team org owners can now manage their org from the website. `/@slug/-/settings`
lets you rename the org, change its avatar, and delete it, and
`/@slug/-/members` shows members and invites. Every org section lives under
`/@slug/-/`, so it never collides with package URLs. Your personal account
settings have their own page, separate from the workspace rail.

### Why it matters

Org profile, membership, and invites were only reachable through MCP. Now an
owner can add a teammate or tidy up the org without asking an agent to do it.

### Example

1. Open `/@your-org/-/members`.
2. Invite a teammate by email or share an invite link.
3. Open `/@your-org/-/settings` to update the org's name and avatar.

Docs: [Organizations](https://kody.codes/docs/organizations) · PRs:
[#3142](https://github.com/kody-hq/kody/pull/3142),
[#3124](https://github.com/kody-hq/kody/pull/3124),
[#3359](https://github.com/kody-hq/kody/pull/3359)

## More updates

- **Automations:** Runs every cron job, webhook, subscription, and inbound email
  as the person who enabled it, with that person's current permissions.
  ([#3388](https://github.com/kody-hq/kody/pull/3388))
- **Credentials:** Puts every credential kind on one Credentials page, with
  default credential mappings per package need at the org level.
  ([docs](https://kody.codes/docs/credentials),
  [#3608](https://github.com/kody-hq/kody/pull/3608),
  [#3757](https://github.com/kody-hq/kody/pull/3757))
- **MCP:** Routes MCP server OAuth through a Kody consent page.
  ([#3205](https://github.com/kody-hq/kody/pull/3205))
- **Orgs:** Makes usernames and org slugs permanent once chosen, and reserves
  `me`. ([#3192](https://github.com/kody-hq/kody/pull/3192),
  [#3221](https://github.com/kody-hq/kody/pull/3221))
- **Packages:** Adds separate forkable and internet-visible toggles to package
  settings. ([#3580](https://github.com/kody-hq/kody/pull/3580))
- **Email:** Runs packages triggered by inbound email as the verified sender.
  ([#3306](https://github.com/kody-hq/kody/pull/3306))
- **Dashboard:** Adds a Copy prompt for your agent button on error pages, and
  feature and use case pages on the website.
  ([#3577](https://github.com/kody-hq/kody/pull/3577),
  [#3172](https://github.com/kody-hq/kody/pull/3172),
  [#3173](https://github.com/kody-hq/kody/pull/3173))

## Fixes

- **Dashboard:** Fixes missing Secrets, Jobs, Repositories, and Connections
  links in the team org workspace rail.
  ([#3230](https://github.com/kody-hq/kody/pull/3230),
  [#3256](https://github.com/kody-hq/kody/pull/3256))
- **Credentials:** Tightens per-resource access checks for memory, jobs, and
  integrations. ([#3412](https://github.com/kody-hq/kody/pull/3412))

## Try it

Open `/@your-org/-/members` and invite one teammate to your team org.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
