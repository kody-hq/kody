---
title: Kody weekly: Plain repos, with packages as an opt-in
date: 2026-08-07
description: Create plain repos with repo_create and promote one to a package when you need it, plus 7 more updates to onboarding, plans, and status.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from August 1 to August 7, 2026. This week repos
become their own primitive, packages react to repo pushes, onboarding becomes a
guided wizard, and Kody gets a public status page.

## Plain repos, with packages as an opt-in

### What shipped

You can now create a plain repo with `repo_create` and edit it like any other
repo session, without making it a package. Packages become an explicit step: you
promote a repo to a package when you want Kody to run its exports, apps, jobs,
or subscriptions. Repo counts are limited by plan: 20 on Free, 200 on Pro, and
400 on partner plans.

### Why it matters

Not everything you keep with your agent is runnable code. Notes, configs,
drafts, and data can live in a versioned repo of their own, and you only take on
the package manifest when you need it.

### Example

Ask your agent to create a repo for your team's runbooks with `repo_create`, add
a `README.md`, and publish. Promote it to a package whenever you want Kody to
run something from it.

PRs: [#1198](https://github.com/kody-hq/kody/pull/1198)

## More updates

- **Packages:** Sends repo push and lifecycle events to package subscriptions,
  so a package can react when a repo changes at HEAD.
  ([docs](https://kody.codes/docs/package-subscriptions),
  [#1209](https://github.com/kody-hq/kody/pull/1209))
- **Dashboard:** Turns onboarding into a guided three-step wizard that ends with
  a zero-setup first win you can copy into your agent.
  ([docs](https://kody.codes/docs/first-win),
  [#1186](https://github.com/kody-hq/kody/pull/1186),
  [#1266](https://github.com/kody-hq/kody/pull/1266))
- **MCP:** Shows a friendly landing page when you open the MCP URL in a browser,
  with a link to onboarding.
  ([#1185](https://github.com/kody-hq/kody/pull/1185))
- **Platform:** Adds a public status page that runs separately from the main
  app. ([#1230](https://github.com/kody-hq/kody/pull/1230))
- **Billing:** Restructures paid plans into Standard at
  $5 a month and Pro at
  $20 a month.
  ([#1242](https://github.com/kody-hq/kody/pull/1242))
- **Credentials:** Bundles provider connect guides for Google, GitHub, Notion,
  Spotify, and Discord into one catalog served to MCP and the site.
  ([#1255](https://github.com/kody-hq/kody/pull/1255))
- **Community:** Adds a follow button for package owners on listing pages.
  ([#1261](https://github.com/kody-hq/kody/pull/1261))

## Fixes

No user-facing fixes this week.

## Try it

Ask your agent to create a plain repo with `repo_create` and add a first file,
then check [Package authoring](https://kody.codes/docs/package-authoring) to see
what promoting it to a package adds.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
