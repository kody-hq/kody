---
title: Kody weekly: Manage package invocation tokens in your account
date: 2026-06-19
description: Create, list, and revoke package invocation tokens from your account, plus 1 more update and 1 fix to integrations and secrets.
order: 1
placeholder: false
---

Here is what shipped in Kody from June 13 to June 19, 2026. This week you can
manage the tokens trusted clients use to call your packages, and your saved
OAuth integrations get their own page.

## Manage package invocation tokens in your account

### What shipped

The new `/account/package-invocation-tokens` page lets you create, list, and
revoke bearer tokens for the external package invocation API. Each token is
limited to the packages, exports, and sources you choose, and `*` allows any
package or export. Kody stores only a hash of each token and shows the raw value
once, when you create it.

### Why it matters

Calling a package export from a script, a shortcut, or another service needs a
credential you can scope and revoke. Before this week that setup lived outside
the account UI. Now you can issue a token for one export, use it, and revoke it
from the same page.

### Example

1. Open `/account/package-invocation-tokens` and create a token limited to one
   package and export.
2. Copy the raw token value, which is shown once.
3. Send a `POST` to `/api/package-invocations/:package/:export` with the token
   as a bearer token from your trusted client.
4. Revoke the token from the same page when you no longer need it.

PRs: [#546](https://github.com/kody-hq/kody/pull/546),
[#548](https://github.com/kody-hq/kody/pull/548)

## More updates

- **Credentials:** Adds an `/account/integrations` page that lists your saved
  OAuth integrations, with reconnect links that load the latest provider config.
  ([docs](https://kody.codes/docs/oauth),
  [#550](https://github.com/kody-hq/kody/pull/550))

## Fixes

- **Credentials:** Fixes the delete button on account secrets, so you can remove
  secrets again. ([#545](https://github.com/kody-hq/kody/pull/545))

## Try it

Create a token for one package export at `/account/package-invocation-tokens`
and call it from a trusted client. See
[Package authoring](https://kody.codes/docs/package-authoring) for exports.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
