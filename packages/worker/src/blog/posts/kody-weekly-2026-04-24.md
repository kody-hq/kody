---
title: Kody weekly: Skills, apps, and jobs become packages
date: 2026-04-24
description: Saved skills and apps now run as repo-backed packages, plus 8 more updates to jobs, repo editing, search, and realtime.
order: 1
category: updates
---

Here is what shipped in Kody from April 18 to April 24, 2026. This week Kody
moves to one saved primitive, the package, and the tools around it (repo
editing, jobs, and search) catch up. Two changes need action: see Breaking
changes below.

## Skills, apps, and jobs become packages

### What shipped

Saved skills and apps now run through a package-first runtime. A package is a
repo-backed module rooted at `package.json`: standard fields such as `name` and
`exports` describe what it offers, and `package.json#kody` holds the Kody
metadata, including an `id`, a description and tags for search, an optional
hosted `app`, and optional package-owned `jobs`. Package exports are importable
across packages by full name, hosted package apps serve nested routes, and
published sources are cached so apps load without reopening a repo session on
every request.

### Why it matters

Instead of separate stores for skills, apps, and schedules, everything you build
with your agent lives in one versioned unit you can read, edit, and publish like
any other code. Search, execute, repo editing, and app hosting all work on the
same thing, so your agent has one place to look before it builds something new.

### Example

A minimal `package.json` for a saved package:

```json
{
	"name": "@my-scope/weekly-digest",
	"exports": { "./summarize": "./src/summarize.ts" },
	"kody": {
		"id": "weekly-digest",
		"description": "Summarizes the week's open pull requests.",
		"tags": ["github", "digest"]
	}
}
```

Another package or `execute` call imports its export as
`kody:@my-scope/weekly-digest/summarize`.

Docs: [Package authoring](https://kody.codes/docs/package-authoring) · PRs:
[#221](https://github.com/kody-hq/kody/pull/221),
[#235](https://github.com/kody-hq/kody/pull/235)

## More updates

- **Packages:** Adds `repo_edit_flow`, which opens or reuses a repo session,
  applies edits, runs checks, and optionally publishes in one call. Sessions can
  open by skill, job, or app identity, and edit details are opt-in with
  `include_edits`. ([#218](https://github.com/kody-hq/kody/pull/218),
  [#234](https://github.com/kody-hq/kody/pull/234),
  [#236](https://github.com/kody-hq/kody/pull/236))
- **Packages:** Publishes new sources straight into their repo on first publish,
  and lets repo-backed jobs and skills import local ES modules.
  ([#194](https://github.com/kody-hq/kody/pull/194),
  [#210](https://github.com/kody-hq/kody/pull/210),
  [#212](https://github.com/kody-hq/kody/pull/212))
- **Automations:** Adds `job_schedule` for standalone repo-backed jobs on a
  one-off, interval, or cron schedule without creating a package first.
  `job_list`, `job_get`, and `job_run_now` inspect and trigger jobs, and jobs
  run from published snapshots.
  ([#237](https://github.com/kody-hq/kody/pull/237),
  [#238](https://github.com/kody-hq/kody/pull/238),
  [#239](https://github.com/kody-hq/kody/pull/239),
  [#251](https://github.com/kody-hq/kody/pull/251))
- **Automations:** Supports an opt-in `repoCheckPolicy` so a repo-backed job can
  run despite typecheck-only failures, including a one-off override on
  `job_run_now`. ([#207](https://github.com/kody-hq/kody/pull/207))
- **Packages:** Adds realtime websocket sessions for package apps and jobs, with
  `session_emit`, `session_broadcast`, and `session_list`, and `realtime` in
  `kody:runtime`. ([#258](https://github.com/kody-hq/kody/pull/258))
- **Apps:** Adds `kodyWidget.appBackend.fetch(...)` and `resolveUrl(...)` for
  authenticated calls from a saved app to its backend, and checks backends when
  you save. ([#219](https://github.com/kody-hq/kody/pull/219))
- **MCP:** Improves `search` with query understanding and task-aware ranking,
  richer hints for package exports, jobs, and apps, and timing metadata on
  `search` and `execute` responses.
  ([#246](https://github.com/kody-hq/kody/pull/246),
  [#252](https://github.com/kody-hq/kody/pull/252),
  [#242](https://github.com/kody-hq/kody/pull/242),
  [#230](https://github.com/kody-hq/kody/pull/230))
- **Credentials:** Adds an official guide for secret-backed integrations:
  research the auth, collect secrets with `/connect/secret`, run a smoke test,
  then build the package.
  ([docs](https://kody.codes/docs/secret-backed-integration),
  [#232](https://github.com/kody-hq/kody/pull/232))

## Fixes

- **Execute:** Fixes `import { ... } from 'kody:runtime'` in module-form execute
  code, including fenced modules.
  ([#250](https://github.com/kody-hq/kody/pull/250))
- **Automations:** Fixes repo-backed jobs and skills that failed to run after
  migration because of entrypoint paths, first-publish auth, or checker errors.
  ([#198](https://github.com/kody-hq/kody/pull/198),
  [#200](https://github.com/kody-hq/kody/pull/200),
  [#203](https://github.com/kody-hq/kody/pull/203),
  [#208](https://github.com/kody-hq/kody/pull/208))
- **Automations:** Fixes scheduled and recurring jobs losing or reusing the
  wrong repo session. ([#217](https://github.com/kody-hq/kody/pull/217),
  [#247](https://github.com/kody-hq/kody/pull/247))
- **Packages:** Fixes package-backed jobs that could not load right after
  `repo_publish_session`. ([#253](https://github.com/kody-hq/kody/pull/253))

## Breaking changes

- **Packages:** Saved packages are imported only by their full
  `package.json.name`, and the leaf of that name must match `kody.id`. The
  `kody.id` shorthand no longer resolves. **Action:** update imports to
  `kody:@scope/package-name/export` and rename packages whose name and id
  differ. ([docs](https://kody.codes/docs/package-authoring),
  [#259](https://github.com/kody-hq/kody/pull/259))
- **MCP:** The `page_to_markdown` capability is removed. **Action:** fetch pages
  from your own code in `execute` or a package instead.
  ([#192](https://github.com/kody-hq/kody/pull/192))

## Try it

Ask your agent to turn one of your saved skills into a package with
`repo_edit_flow`, following
[Package authoring](https://kody.codes/docs/package-authoring).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
