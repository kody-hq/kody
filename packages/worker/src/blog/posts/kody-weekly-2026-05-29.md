---
title: Kody weekly: Read what each package publish recorded
date: 2026-05-29
description: Publishes record Kody publish notes you can read with repo_show_publish_note, plus 1 more update to package and account cleanup.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from May 23 to May 29, 2026. This is a quiet week:
package publishes now leave a readable record, and deletes clean up after
themselves.

## Read what each package publish recorded

### What shipped

When a repo session publishes, a source repo is bootstrapped, or an externally
pushed commit is published, Kody now writes structured publish metadata as a git
note on that commit. The new `repo_show_publish_note` capability reads it back.

### Why it matters

When a package starts behaving differently, the first question is what was
published and how. The publish note travels with the commit in your package
repo, so you and your agent can answer that from the repo itself.

### Example

Ask your agent to call `repo_show_publish_note` for your package's latest
published commit after its next publish, and summarize what the note recorded.

PRs: [#509](https://github.com/kody-hq/kody/pull/509)

## More updates

- **Packages:** Makes deleting a package or your account also remove the related
  package source and session repos, alongside the existing data cleanup.
  ([#511](https://github.com/kody-hq/kody/pull/511))

## Fixes

No user-facing fixes this week.

## Try it

Publish a small change to one of your packages, then ask your agent to read the
note with `repo_show_publish_note`. See
[Package authoring](https://kody.codes/docs/package-authoring) for the publish
flow.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
