---
title: Kody weekly: small fixes and maintenance
date: 2026-06-12
description: package_save spells out its source safety policy, and package remotes and sessions fail clearly on empty sources.
order: 1
placeholder: false
---

Here is what shipped in Kody from June 6 to June 12, 2026. This is a quiet week
focused on keeping package sources safe.

## This week: small fixes and maintenance

`package_save` now shows the full package source safety policy, and whole-source
overwrites still need explicit confirmation
([#525](https://github.com/kody-hq/kody/pull/525)). Package git remotes and repo
sessions now fail with a clear error when a package source is missing or empty
([#529](https://github.com/kody-hq/kody/pull/529)), and the secret value toggle
reads Show and Hide ([#528](https://github.com/kody-hq/kody/pull/528)).

## More updates

- **Packages:** Makes `package_save` show the full source safety policy,
  including the confirmation required before overwriting a whole package source.
  ([#525](https://github.com/kody-hq/kody/pull/525))
- **Credentials:** Labels the account secret value toggle with Show and Hide
  text. ([#528](https://github.com/kody-hq/kody/pull/528))

## Fixes

- **Packages:** Fixes package git remotes and repo sessions opening on a missing
  or empty package source. They now fail with a clear error.
  ([#529](https://github.com/kody-hq/kody/pull/529))

## Try it

Before your next whole-package change, read the policy in `package_save` and
follow the [Package authoring](https://kody.codes/docs/package-authoring) flow.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
