---
title: Kody weekly: Manage webhook URLs from your account
date: 2026-09-18
description: Mint, reveal, rotate, and disable webhook URLs at /account/webhooks, plus 7 more updates to connections, email, and package apps.
order: 1
placeholder: false
---

Here is what shipped in Kody from September 12 to September 18, 2026. This week
webhook URLs get a page of their own, connected agents get a Connections page,
and you can send email to more than your own address. One change needs action:
see Breaking changes below.

## Manage webhook URLs from your account

### What shipped

`/account/webhooks` lists the webhook URLs you have minted for your packages.
From there you can mint a URL, reveal and copy it, rotate it, and enable or
disable it. The URL itself only appears on this page, never in what your agent
sees. When you rotate a URL, the previous one keeps working briefly so you have
time to update the sender.

### Why it matters

A webhook URL is a credential: anyone who has it can call your package. Keeping
it on a page only you can open, with rotation that does not drop events, makes
it practical to replace a URL whenever you need to.

### Example

1. Open `/account/webhooks` and select the webhook for your package.
2. Select **Rotate**, then copy the new URL.
3. Paste it into the provider's webhook settings before the old URL stops.

Docs: [Triggers](https://kody.codes/docs/triggers) · PRs:
[#2262](https://github.com/kody-hq/kody/pull/2262),
[#2274](https://github.com/kody-hq/kody/pull/2274)

## More updates

- **Orgs:** Adds `/account/connections` for connected agents, with each agent's
  last use and a revoke button.
  ([#2255](https://github.com/kody-hq/kody/pull/2255),
  [#2260](https://github.com/kody-hq/kody/pull/2260),
  [#2283](https://github.com/kody-hq/kody/pull/2283))
- **Email:** Lets you add up to 5 verified destination addresses to send to, and
  adds attachments to `emailSend`.
  ([#2293](https://github.com/kody-hq/kody/pull/2293),
  [#2296](https://github.com/kody-hq/kody/pull/2296))
- **Packages:** Shows a `.kody/icon` image for packages and repos, and adds
  Repo, Files, and Settings tabs plus an Open Package App link to package
  details. ([#2320](https://github.com/kody-hq/kody/pull/2320),
  [#2326](https://github.com/kody-hq/kody/pull/2326),
  [#2317](https://github.com/kody-hq/kody/pull/2317))
- **MCP:** Ranks connected MCP servers in search as single results instead of
  listing every remote tool.
  ([#2269](https://github.com/kody-hq/kody/pull/2269))
- **Dashboard:** Replaces the onboarding interview with a first-win picker.
  ([docs](https://kody.codes/docs/first-win),
  [#2330](https://github.com/kody-hq/kody/pull/2330))
- **Dashboard:** Adds illustrated 404 and 500 pages.
  ([#2261](https://github.com/kody-hq/kody/pull/2261))
- **Docs:** Points ChatGPT and Codex setup at the published plugin.
  ([#2322](https://github.com/kody-hq/kody/pull/2322))

## Fixes

- **MCP:** Fixes MCP OAuth servers losing refresh tokens and needing repeated
  reconnects. ([#2328](https://github.com/kody-hq/kody/pull/2328))
- **Orgs:** Fixes OAuth sign-in for clients like Codex that check the issuer on
  the redirect. ([#2279](https://github.com/kody-hq/kody/pull/2279))

## Breaking changes

- **Apps:** Hosted package apps are now a plain Worker fetch handler contract,
  and `kody.app.runtime` is removed. **Action:** remove `kody.app.runtime` from
  `package.json` and export a fetch handler from your app entry. See
  [Package apps](https://kody.codes/docs/package-apps).
  ([#2290](https://github.com/kody-hq/kody/pull/2290),
  [#2312](https://github.com/kody-hq/kody/pull/2312))

## Try it

Open `/account/webhooks`, rotate one webhook URL, and update its sender while
the old URL still works.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
