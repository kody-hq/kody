---
title: Kody weekly: Connect GitHub, Google, and Slack with built-in OAuth
date: 2026-08-14
description: Built-in OAuth integrations connect providers without your own OAuth app, plus 7 more updates and 2 breaking changes to domains and limits.
order: 1
placeholder: false
---

Here is what shipped in Kody from August 8 to August 14, 2026. This week Kody
moves to kody.codes, built-in OAuth integrations make connecting providers one
click, and package apps get their own subdomain per user. Two changes need
action: see Breaking changes below.

## Connect GitHub, Google, and Slack with built-in OAuth

### What shipped

Kody now ships built-in OAuth integrations for providers such as GitHub, Google,
and Slack. When a built-in is ready, selecting Connect sends you straight to the
provider's consent screen, with no OAuth app of your own to register. Onboarding
leads with built-in integration cards, and if finishing a connection would
replace a different connection, Kody asks you first. You can still bring your
own OAuth app.

### Why it matters

Registering an OAuth app, copying a client id and secret, and setting redirect
URIs is the slowest part of connecting a provider. Built-ins cut that to a
consent screen, so your agent can start using GitHub or Google in the same
session you sign up.

### Example

1. Open onboarding or the connect page and pick a built-in provider card.
2. Approve access on the provider's consent screen.
3. Ask your agent to `search` for that provider and call it from `execute`.

Docs: [OAuth](https://kody.codes/docs/oauth) · PRs:
[#1303](https://github.com/kody-hq/kody/pull/1303),
[#1343](https://github.com/kody-hq/kody/pull/1343)

## More updates

- **Packages:** Adds `package_app_fetch` and related capabilities that send
  synthetic requests to your published package so you can test it.
  ([#1315](https://github.com/kody-hq/kody/pull/1315))
- **MCP:** Accepts a bearer token when you add a remote MCP server.
  ([#1398](https://github.com/kody-hq/kody/pull/1398))
- **Community:** Gives community packages readable URLs at `/@owner/kody-id`,
  and adds follow buttons next to usernames on profiles.
  ([#1380](https://github.com/kody-hq/kody/pull/1380),
  [#1338](https://github.com/kody-hq/kody/pull/1338))
- **Dashboard:** Lets your agent drive the whole first-run loop from one paste,
  and adds GitHub Copilot setup to onboarding.
  ([docs](https://kody.codes/docs/first-win),
  [#1371](https://github.com/kody-hq/kody/pull/1371),
  [#1295](https://github.com/kody-hq/kody/pull/1295))
- **MCP:** Sends progress notifications during long installs and adds onboarding
  prompts. ([#1370](https://github.com/kody-hq/kody/pull/1370))
- **Platform:** Makes capability validation errors readable for agents.
  ([#1376](https://github.com/kody-hq/kody/pull/1376))
- **Platform:** Shows relevant Cloudflare incidents on the status page.
  ([#1296](https://github.com/kody-hq/kody/pull/1296))

## Fixes

- **Execute:** Fixes bulk run triage failing at the 100-item limit.
  ([#1329](https://github.com/kody-hq/kody/pull/1329))
- **Credentials:** Tightens password and secret handling.
  ([#1382](https://github.com/kody-hq/kody/pull/1382))

## Breaking changes

- **Platform:** Kody's canonical web origin and email domain are now kody.codes,
  and package apps move to per-user subdomains. **Action:** update bookmarks,
  OAuth redirect URIs, and anything that sends mail to your Kody inbox to the
  new addresses shown in your account.
  ([#1418](https://github.com/kody-hq/kody/pull/1418),
  [#1395](https://github.com/kody-hq/kody/pull/1395))
- **Billing:** Free plan limits are tighter, with a new daily job-run quota.
  **Action:** check your usage page and upgrade if you are over a limit.
  ([#1327](https://github.com/kody-hq/kody/pull/1327))

## Try it

Connect GitHub or Google with a built-in card, then follow the
[OAuth docs](https://kody.codes/docs/oauth) to call it from `execute`.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
