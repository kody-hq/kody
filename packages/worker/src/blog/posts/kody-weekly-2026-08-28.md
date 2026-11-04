---
title: Kody weekly: Choose the OAuth scopes a connection requests
date: 2026-08-28
description: Pick providers and OAuth scopes from /connect/oauth, plus 5 more updates and 2 breaking changes to package composition and jobs.
order: 1
category: updates
---

Here is what shipped in Kody from August 22 to August 28, 2026. This week you
can choose OAuth scopes when you connect, set expiry dates on secrets, and get
an email before you hit a plan limit. Two changes need action: see Breaking
changes below.

## Choose the OAuth scopes a connection requests

### What shipped

Visiting `/connect/oauth` while signed in now shows a chooser of enabled
built-in providers and your saved connections. When you start a connection, you
pick which OAuth scopes it requests. When your agent needs more access than the
current token has, Kody tells it so plainly and points you back to the scope
picker.

### Why it matters

You decide how much a connection can do instead of accepting whatever a
hand-built URL asked for. Starting narrow and adding a scope when you need it
keeps each grant to the access you actually use.

### Example

1. Open `/connect/oauth` and choose GitHub.
2. Select only the scopes you need, such as reading repositories.
3. Ask your agent to list your repositories through the connection.

Docs: [OAuth](https://kody.codes/docs/oauth) · PRs:
[#1633](https://github.com/kody-hq/kody/pull/1633)

## More updates

- **Credentials:** Lets you set an expiry date on a secret from the account UI,
  from your agent, and in secret create links.
  ([docs](https://kody.codes/docs/secrets),
  [#1703](https://github.com/kody-hq/kody/pull/1703))
- **Billing:** Emails you when your account reaches 80% and 100% of a plan
  limit. ([#1708](https://github.com/kody-hq/kody/pull/1708))
- **Memory:** Surfaces compact one-line summaries of your top memories to your
  agent, and collapses memories that share a `dedupe_key`.
  ([docs](https://kody.codes/docs/memory),
  [#1646](https://github.com/kody-hq/kody/pull/1646),
  [#1649](https://github.com/kody-hq/kody/pull/1649))
- **Community:** Groups the community catalog into categories.
  ([#1672](https://github.com/kody-hq/kody/pull/1672))
- **Community:** Crops, zooms, and converts avatar uploads in the browser.
  ([#1768](https://github.com/kody-hq/kody/pull/1768))

## Fixes

- **Packages:** Fixes `repo_edit_files` keeping only the last of several edits
  to the same file. ([#1759](https://github.com/kody-hq/kody/pull/1759))
- **MCP:** Fixes MCP refresh tokens and client registrations expiring on a
  timer, so well-behaved hosts stay connected.
  ([#1793](https://github.com/kody-hq/kody/pull/1793))

## Breaking changes

- **Packages:** `packages.invoke` is removed from package code. **Action:**
  compose with static `kody:@` imports, use `import(specifier)` when the package
  name is data, and use workflows when you need exactly-once runs.
  ([#1742](https://github.com/kody-hq/kody/pull/1742),
  [#1686](https://github.com/kody-hq/kody/pull/1686))
- **Automations:** Unattached jobs and `createJob` are removed. **Action:**
  declare schedules on a package's jobs or use `workflows.create`.
  ([#1642](https://github.com/kody-hq/kody/pull/1642),
  [#1725](https://github.com/kody-hq/kody/pull/1725))

## Try it

Open `/connect/oauth`, connect a provider with only the scopes you need, and set
an expiry on one secret you only need for a short time.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
