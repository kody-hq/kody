---
title: Kody weekly: OAuth reconnects keep working after reauth
date: 2026-05-22
description: Authenticated fetch uses your saved access token and keeps your refresh token name after reauth, plus no other updates this week.
order: 1
category: updates
---

Here is what shipped in Kody from May 16 to May 22, 2026. This is a quiet week
with one fix to how OAuth integrations behave after you reconnect them.

## This week: small fixes and maintenance

This week we fixed OAuth reauth for providers that do not return a new refresh
token: Kody keeps the refresh token secret name you configured, and
authenticated fetch now uses the saved access token first, refreshing and
retrying once only when the token is missing or a request returns 401
([#488](https://github.com/kody-hq/kody/pull/488)). The rest of the week was
deploy reliability work.

## More updates

No other improvements this week.

## Fixes

- **Credentials:** Fixes OAuth integrations losing their refresh token setup
  after a reauth, and requests refreshing a token they did not need to.
  ([docs](https://kody.codes/docs/oauth),
  [#488](https://github.com/kody-hq/kody/pull/488))

## Try it

Reconnect one of your OAuth integrations from the
[OAuth docs](https://kody.codes/docs/oauth) flow and run a request through it
with `execute`.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
