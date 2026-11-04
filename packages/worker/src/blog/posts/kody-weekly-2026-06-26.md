---
title: Kody weekly: Repo sessions work on branches in your package repo
date: 2026-06-26
description: Repo sessions now use sessions branches in the source repo, plus 3 more updates to package tokens and errors, and 2 breaking changes.
order: 1
category: updates
---

Here is what shipped in Kody from June 20 to June 26, 2026. This week repo
sessions move onto branches in your package repo, package tokens get a full
editor, and errors that used to fail quietly now fail loudly. Two changes need
action: see Breaking changes below.

## Repo sessions work on branches in your package repo

### What shipped

A repo session now lives on a `sessions/<id>` branch in the package's own source
repo instead of a separate fork. Kody records the upstream branch each session
started from and uses it when the session rebases and publishes.

### Why it matters

Your in-progress edits sit next to the published code in one repo, so there is
one place to look at what changed and one history to reason about. Rebase and
publish follow the branch the session came from.

### Example

Ask your agent to open a repo session on one of your packages, make a small
edit, run checks, and publish. The session's work lands on a `sessions/<id>`
branch in that package's repo until it publishes.

PRs: [#558](https://github.com/kody-hq/kody/pull/558)

## More updates

- **Credentials:** Gives each package invocation token a stable detail page and
  an editor like the secrets one. You can rotate a token by entering a new
  write-only value, and existing raw values are never shown.
  ([#562](https://github.com/kody-hq/kody/pull/562),
  [#563](https://github.com/kody-hq/kody/pull/563),
  [#564](https://github.com/kody-hq/kody/pull/564),
  [#565](https://github.com/kody-hq/kody/pull/565))
- **Packages:** Shows each export's external invocation URL in `package_get` and
  package search details, using the username-scoped
  `/@username/api/package-invocations/...` route.
  ([#568](https://github.com/kody-hq/kody/pull/568))
- **Platform:** Makes invalid config, bad JSON, and partial failures in search,
  connectors, and publish return clear errors instead of empty or degraded
  results. ([#551](https://github.com/kody-hq/kody/pull/551))

## Fixes

- **Packages:** Fixes publish and artifact rebuild errors that did not say which
  target failed, and retries brief resets on external push.
  ([#560](https://github.com/kody-hq/kody/pull/560))

## Breaking changes

- **Packages:** Repo sessions opened before this change are not carried over.
  **Action:** open a new repo session for any package edit that was in progress.
  ([#558](https://github.com/kody-hq/kody/pull/558))
- **Packages:** Standalone `skill` and `app` sources are removed. Repo-backed
  sources are now packages and jobs only. **Action:** keep skills and apps in a
  package. ([docs](https://kody.codes/docs/package-authoring),
  [#559](https://github.com/kody-hq/kody/pull/559))

## Try it

Ask your agent to make one small edit to a package in a repo session and publish
it, following [Package authoring](https://kody.codes/docs/package-authoring).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
