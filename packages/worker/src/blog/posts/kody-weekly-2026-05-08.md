---
title: Kody weekly: Schedule durable workflows from any code
date: 2026-05-08
description: workflows.create runs code or a package export on a delay from any Kody runtime, plus 8 more updates and 4 breaking changes to review.
order: 1
placeholder: false
---

Here is what shipped in Kody from May 2 to May 8, 2026. This week your code can
schedule durable work to run on a delay, saved connectors become integrations,
and repo editing moves to git commands. Four changes need action: see Breaking
changes below.

## Schedule durable workflows from any code

### What shipped

`workflows.create` from `kody:runtime` now works in every server-side runtime:
`execute`, scheduled jobs, package jobs, package subscriptions, package exports,
and package services. Pass either `code` (a complete ESM module with a default
export) or `exportName` (a saved package export), plus a `runAt` time and an
`idempotencyKey`. Calling it again with the same key and time returns the
existing workflow instead of starting a duplicate, and `workflow_list` shows
recent runs and their status.

### Why it matters

Some work should not happen right away: a follow-up check in an hour, a reminder
tomorrow, a retry after a provider recovers. You can queue that from the code
you are already running, without creating a job first, and safely retry the
call.

### Example

Run this with `execute` to queue a run one minute from now:

```ts
import { workflows } from 'kody:runtime'

export default async function main() {
	return await workflows.create({
		runAt: new Date(Date.now() + 60_000).toISOString(),
		idempotencyKey: 'follow-up-check-1',
		code: 'export default async function main(p) { return { ok: true, p } }',
		params: { greeting: 'hello' },
	})
}
```

PRs: [#335](https://github.com/kody-hq/kody/pull/335),
[#401](https://github.com/kody-hq/kody/pull/401),
[#403](https://github.com/kody-hq/kody/pull/403),
[#406](https://github.com/kody-hq/kody/pull/406)

## More updates

- **Automations:** Adds `job_update` and `job_delete`. `job_update` changes a
  job's name, code, params, schedule, timezone, enabled state, or kill switch.
  ([#331](https://github.com/kody-hq/kody/pull/331))
- **Execute:** Adds an optional `responseLimit` to `execute`, about 100 KB by
  default, with truncation metadata and `returnedBytes` on every response.
  ([#381](https://github.com/kody-hq/kody/pull/381))
- **MCP:** Makes `search({ query })` return a compact ranked list, with full
  detail behind `search({ entity })`. Package detail shows referenced types,
  ready-to-use `kody:` import specifiers, and README snippets.
  ([#362](https://github.com/kody-hq/kody/pull/362),
  [#357](https://github.com/kody-hq/kody/pull/357),
  [#358](https://github.com/kody-hq/kody/pull/358),
  [#382](https://github.com/kody-hq/kody/pull/382),
  [#383](https://github.com/kody-hq/kody/pull/383),
  [#385](https://github.com/kody-hq/kody/pull/385))
- **Packages:** Adds `package_get_git_remote` for short-lived git credentials to
  a package repo and `package_publish_external_push` to publish a HEAD you
  pushed from your own machine.
  ([#352](https://github.com/kody-hq/kody/pull/352))
- **Packages:** Adds `repo_run_commands`, one constrained git command workflow
  for editing package repos, and `repo_write_file` for whole-file overwrites.
  ([#340](https://github.com/kody-hq/kody/pull/340),
  [#404](https://github.com/kody-hq/kody/pull/404))
- **Credentials:** Loads a selected secret into the account editor, masked by
  default, without a separate reveal step, and truncates long secret names.
  ([#323](https://github.com/kody-hq/kody/pull/323),
  [#328](https://github.com/kody-hq/kody/pull/328),
  [#398](https://github.com/kody-hq/kody/pull/398))
- **Platform:** Adds remote connector settings to your account, with encrypted
  shared secrets and links from the secrets page.
  ([#393](https://github.com/kody-hq/kody/pull/393),
  [#395](https://github.com/kody-hq/kody/pull/395),
  [#397](https://github.com/kody-hq/kody/pull/397))

## Fixes

- **Platform:** Tightens session, secret, and route handling, and keeps
  sensitive details out of error paths.
  ([#315](https://github.com/kody-hq/kody/pull/315),
  [#317](https://github.com/kody-hq/kody/pull/317),
  [#316](https://github.com/kody-hq/kody/pull/316))
- **Credentials:** Fixes the account secrets page failing to load for some
  accounts. ([#396](https://github.com/kody-hq/kody/pull/396))
- **Automations:** Fixes jobs running a stale bundle after an update, and
  recurring package workflows reusing one run.
  ([#390](https://github.com/kody-hq/kody/pull/390),
  [#389](https://github.com/kody-hq/kody/pull/389))
- **Packages:** Fixes cross-package default imports, checks for named-only
  export modules, and publishing externally pushed commits.
  ([#386](https://github.com/kody-hq/kody/pull/386),
  [#363](https://github.com/kody-hq/kody/pull/363),
  [#365](https://github.com/kody-hq/kody/pull/365))

## Breaking changes

- **Execute:** Ambient `params` is removed from `kody:runtime`. Execute code,
  jobs, and package exports receive input as the default export's argument.
  **Action:** change code that reads `params` to
  `export default async function main(input = {})`.
  ([#384](https://github.com/kody-hq/kody/pull/384))
- **Packages:** Repo-backed job and package entrypoints must be ESM modules with
  a default export. **Action:** convert snippet-style entrypoints to
  `export default async function`.
  ([#373](https://github.com/kody-hq/kody/pull/373))
- **Credentials:** Saved OAuth and user config connectors are now integrations.
  **Action:** call `integration_get`, `integration_list`, `integration_save`,
  and `integration_delete` instead of the connector capabilities.
  ([#391](https://github.com/kody-hq/kody/pull/391))
- **Packages:** `repo_edit_flow` and `repo_apply_patch` are removed. **Action:**
  edit package repos with `repo_run_commands` or `repo_write_file`.
  ([#340](https://github.com/kody-hq/kody/pull/340))

## Try it

Run the example above with `execute`, then call `workflow_list` after a minute
to see the run finish.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
