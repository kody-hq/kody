---
title: Kody weekly: Install community packages in one click
date: 2026-07-17
description: Community listings install into your account as live packages in one click, plus 7 more updates to packages, onboarding, and email.
order: 1
category: updates
---

Here is what shipped in Kody from July 11 to July 17, 2026. This week community
packages become one click to install, your account gets a packages browser, and
onboarding shows setup for each MCP client.

## Install community packages in one click

### What shipped

Community listing pages now have an **Install** button. Install forks the
listing into your account, runs the same publish checks a repo session runs,
and, when they pass, publishes it as a live saved package. Listings an admin has
reviewed carry a trusted mark, and installing an untrusted listing asks you to
confirm first. Admins can also feature trusted listings, which appear on
onboarding as starter packages.

### Why it matters

Finding a package someone else built is only useful if trying it is quick. You
get a working copy you own, checked the same way your own packages are, and the
trusted mark tells you which listings someone has reviewed.

### Example

1. Open a community listing and read its README.
2. Select **Install**. For an untrusted listing, confirm the warning.
3. Ask your agent to `search` for the package and run one of its exports.

Docs: [Package sharing](https://kody.codes/docs/package-sharing) · PRs:
[#763](https://github.com/kody-hq/kody/pull/763),
[#760](https://github.com/kody-hq/kody/pull/760),
[#765](https://github.com/kody-hq/kody/pull/765)

## More updates

- **Packages:** Adds `/account/packages` to browse your saved packages with
  search, filters, sort, and infinite scroll.
  ([#745](https://github.com/kody-hq/kody/pull/745))
- **Packages:** Lets you hide a package from default search while it stays
  runnable, with `package_update({ package_id, changes: { hidden } })`. Search
  also resolves exact package ids and hosted URLs.
  ([#746](https://github.com/kody-hq/kody/pull/746),
  [#753](https://github.com/kody-hq/kody/pull/753))
- **Community:** Renders listing READMEs as markdown and adds the package icon
  to listing preview cards. ([#740](https://github.com/kody-hq/kody/pull/740),
  [#739](https://github.com/kody-hq/kody/pull/739),
  [#725](https://github.com/kody-hq/kody/pull/725))
- **Dashboard:** Makes `/onboarding` public and adds copyable setup for Cursor,
  Claude, VS Code, and other MCP clients.
  ([docs](https://kody.codes/docs/connect-your-agent),
  [#761](https://github.com/kody-hq/kody/pull/761),
  [#764](https://github.com/kody-hq/kody/pull/764),
  [#766](https://github.com/kody-hq/kody/pull/766))
- **MCP:** Cuts search round trips: `entity` accepts several entities at once
  and results include call shapes and related operations.
  ([#769](https://github.com/kody-hq/kody/pull/769))
- **Execute:** Passes image, audio, and resource blocks from downstream MCP
  servers through `execute`, within media limits.
  ([#734](https://github.com/kody-hq/kody/pull/734))
- **Email:** Adds outbound delivery events. Delivery state shows in email
  capabilities, and packages can subscribe to `email.message.delivery.updated`.
  ([#780](https://github.com/kody-hq/kody/pull/780),
  [#781](https://github.com/kody-hq/kody/pull/781))

## Fixes

- **Packages:** Fixes raw git pushes from repo sessions failing to publish.
  ([#762](https://github.com/kody-hq/kody/pull/762))
- **Orgs:** Fixes passkey sign-in asking for a TOTP code when 2FA is on.
  ([#774](https://github.com/kody-hq/kody/pull/774))
- **Dashboard:** Fixes the nav still showing you signed in after Log out.
  ([#776](https://github.com/kody-hq/kody/pull/776))
- **Execute:** Fixes `execute` failing on raw fetch calls.
  ([#771](https://github.com/kody-hq/kody/pull/771))

## Try it

Open a community listing from
[Package sharing](https://kody.codes/docs/package-sharing), install it, and ask
your agent to run one of its exports.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
