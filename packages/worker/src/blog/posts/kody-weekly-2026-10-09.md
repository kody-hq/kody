---
title: Kody weekly: See where your credits went
date: 2026-10-09
description: Usage and package pages break down where compute went, plus 5 more updates to secrets, packages, and tokens, and 2 breaking changes.
order: 1
placeholder: false
---

Here is what shipped in Kody from October 3 to October 9, 2026. This week usage
pages show which packages used your compute, renamed packages redirect, and
agent secret links get a focused page. Two changes need action: see Breaking
changes below.

## See where your credits went

### What shipped

Your usage page and each package's page now have a **Where it went** breakdown.
Under included compute, it shows how much went to each package and to ad hoc
runs, so you can see which package is driving your bill. Signed-in package apps
and MCP clients can read the same data per package with
`kody.usageByPackageGet`.

### Why it matters

A credits total does not tell you what to change. Seeing usage by package points
you at the job that runs too often or the export worth optimizing.

### Example

Open `/account/usage`, find the package at the top of Where it went, and open
its package page to see its share of your compute.

PRs: [#2852](https://github.com/kody-hq/kody/pull/2852)

## More updates

- **Packages:** Resolves packages by slug or id and redirects old slugs after a
  rename, including a 308 redirect for package apps.
  ([#2933](https://github.com/kody-hq/kody/pull/2933),
  [#2968](https://github.com/kody-hq/kody/pull/2968))
- **Credentials:** Adds a focused `/connect/secret-set` page for links your
  agent sends to set a secret.
  ([#2910](https://github.com/kody-hq/kody/pull/2910))
- **CLI:** Keeps CLI bootstrap credentials for 2 weeks idle and 3 months at
  most. ([#2909](https://github.com/kody-hq/kody/pull/2909))
- **Billing:** Retries the $5 signup welcome credit when the first grant fails.
  ([#2899](https://github.com/kody-hq/kody/pull/2899))
- **Platform:** Adds a case studies page at `/case-studies`.
  ([#2844](https://github.com/kody-hq/kody/pull/2844))

## Fixes

- **Credentials:** Fixes OAuth resource URIs over plain HTTP crashing instead of
  redirecting to HTTPS. ([#2871](https://github.com/kody-hq/kody/pull/2871))
- **Credentials:** Tightens Open API bootstrap credentials.
  ([#2848](https://github.com/kody-hq/kody/pull/2848))

## Breaking changes

- **Credentials:** Package invocation tokens are removed. **Action:** trigger
  package exports from outside Kody with a package webhook instead.
  ([docs](https://kody.codes/docs/triggers),
  [#3024](https://github.com/kody-hq/kody/pull/3024))
- **Credentials:** API tokens now require a lifetime, and the oldest tokens are
  reclaimed at the active token cap. **Action:** set a lifetime when you create
  a token, and replace long-lived tokens your scripts rely on.
  ([docs](https://kody.codes/docs/api-tokens),
  [#2986](https://github.com/kody-hq/kody/pull/2986))

## Try it

Open `/account/usage` and check Where it went to find the package using the most
compute.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
