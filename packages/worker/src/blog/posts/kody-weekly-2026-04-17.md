---
title: Kody weekly: Schedule code with one jobs system
date: 2026-04-17
description: A unified job_* surface runs your code on cron, interval, or one-time schedules, plus 8 more updates to storage, apps, memory, and repos.
order: 1
category: updates
---

Here is what shipped in Kody from April 11 to April 17, 2026. This week your
code can run on a schedule, keep its own storage, and live in repos, and saved
apps get real backends.

## Schedule code with one jobs system

### What shipped

Kody now has jobs. The `job_upsert`, `job_list`, `job_get`, `job_delete`, and
`job_run_now` capabilities create and manage code that runs on a schedule. A
schedule is a `cron` expression, an `interval` such as `15m` or `1d`, or a
`once` run at an ISO timestamp, and cron schedules can use an IANA timezone.
Each job keeps its run counts, last error, last duration, and a short run
history, and you can disable a job or flip its kill switch without deleting it.
Jobs run through the same codemode runtime as `execute` and get a stable
`storageId` for durable data.

### Why it matters

Recurring work like a morning digest or a weekly cleanup no longer depends on
you remembering to ask. Your agent writes the code once, schedules it, and you
can see whether it ran and why it failed. It is the first step from one-off
answers to automations you own.

### Example

Call `job_upsert` from `execute` with a name, code, and schedule:

```json
{
	"name": "weekday-digest",
	"code": "async () => { /* gather and summarize */ return 'ok' }",
	"schedule": { "type": "cron", "expression": "0 8 * * 1-5" },
	"timezone": "America/Denver",
	"params": { "topic": "open pull requests" }
}
```

Use `job_run_now` with the returned id to test it right away, and `job_get` to
read its run history.

PRs: [#157](https://github.com/kody-hq/kody/pull/157),
[#170](https://github.com/kody-hq/kody/pull/170),
[#171](https://github.com/kody-hq/kody/pull/171)

## More updates

- **Execute:** Adds durable storage. `execute` accepts a `storageId` and
  `writable`, code can use the built-in `storage.*` helpers and
  `storage.sql(...)`, and `storage_query` and `storage_export` inspect a store
  read-only by default. ([#171](https://github.com/kody-hq/kody/pull/171))
- **Apps:** Gives each saved app an optional server backend. App code splits
  into client and server parts, the server part runs as its own Durable Object
  with an isolated SQLite database, and the client reaches it at
  `/app/:appId/*`. ([#162](https://github.com/kody-hq/kody/pull/162),
  [#166](https://github.com/kody-hq/kody/pull/166))
- **Packages:** Adds repo-backed sources. Apps, skills, and jobs can live in
  repos, and `repo_*` capabilities open sessions, read and search files, apply
  edits, run checks, and publish. `repo_backfill_sources` moves existing inline
  apps, skills, and jobs into repos without overwriting published sources.
  ([#181](https://github.com/kody-hq/kody/pull/181),
  [#187](https://github.com/kody-hq/kody/pull/187))
- **Execute:** Supports returning raw MCP content blocks, such as images, from
  `execute` through `__mcpContent` instead of text only.
  ([#149](https://github.com/kody-hq/kody/pull/149),
  [#151](https://github.com/kody-hq/kody/pull/151))
- **Execute:** Adds agent turn capabilities: `agent_chat_turn` for one bounded
  tool-using turn, and `agent_turn_start`, `agent_turn_next`, and
  `agent_turn_cancel` to stream one.
  ([#180](https://github.com/kody-hq/kody/pull/180))
- **Memory:** Supports optional source URIs on memories, and `search` uses your
  query as memory context when you leave `memoryContext` out.
  ([docs](https://kody.codes/docs/memory),
  [#168](https://github.com/kody-hq/kody/pull/168),
  [#154](https://github.com/kody-hq/kody/pull/154))
- **Platform:** Generalizes the home connector into remote connectors, with
  separate sessions, routing, and secrets per connector, plus connector status
  in search. ([#155](https://github.com/kody-hq/kody/pull/155))
- **Orgs:** Adds a reset button on the authorize screen when a redirect URI
  mismatch leaves an MCP client stuck, so you can remove the stale client and
  sign in again. ([#161](https://github.com/kody-hq/kody/pull/161),
  [#169](https://github.com/kody-hq/kody/pull/169))

## Fixes

- **Apps:** Fixes `ui_save_app` partial updates wiping fields you did not
  change. ([#165](https://github.com/kody-hq/kody/pull/165))
- **Execute:** Fixes read-only storage SQL rejecting queries with semicolons
  inside strings or comments. ([#173](https://github.com/kody-hq/kody/pull/173))
- **Automations:** Fixes jobs reusing stale repo sessions. They now fail clearly
  instead. ([#184](https://github.com/kody-hq/kody/pull/184),
  [#191](https://github.com/kody-hq/kody/pull/191))

## Try it

Ask your agent to schedule one small recurring task with `job_upsert`, then run
it once with `job_run_now` and check the result with `job_get`.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
