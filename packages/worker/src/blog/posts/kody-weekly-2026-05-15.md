---
title: Kody weekly: Packages can call each other at runtime
date: 2026-05-15
description: packages.invoke and packages.invokeChecked call another package's current export, plus 8 more updates and 4 breaking changes.
order: 1
placeholder: false
---

Here is what shipped in Kody from May 9 to May 15, 2026. This week packages can
call each other and dispatch events at runtime, you get debug traces for package
runs, and accounts get usernames. Four changes need action: see Breaking changes
below.

## Packages can call each other at runtime

### What shipped

`packages.invoke` from `kody:runtime` calls another of your packages by its
`kodyId` and `exportName`, and runs that package's current published export.
`packages.check` resolves the target first and returns its current contract, and
`packages.invokeChecked` checks and invokes in one call. These work in package
runtimes and, as of this week, in authenticated `execute` calls too. Static
`kody:@scope/package/export` imports still bundle a published snapshot, so you
choose per call whether you want a fixed dependency or the latest version.

### Why it matters

When one package hands work to another, like a gateway passing events to a
handler, you can republish the handler without republishing the caller. The
checked variant catches a changed contract before the call, instead of failing
inside it.

### Example

```ts
import { packages } from 'kody:runtime'

export default async function main(input = {}) {
	return await packages.invokeChecked({
		kodyId: 'issue-triage',
		exportName: './handle-new-issue',
		params: { issue: input.issue, dryRun: true },
	})
}
```

PRs: [#429](https://github.com/kody-hq/kody/pull/429),
[#434](https://github.com/kody-hq/kody/pull/434),
[#435](https://github.com/kody-hq/kody/pull/435),
[#471](https://github.com/kody-hq/kody/pull/471)

## More updates

- **Packages:** Adds package events. Declare topics in `kody.emits` and call
  `events.dispatch`, and the same user's package subscriptions run in turn.
  ([docs](https://kody.codes/docs/package-subscriptions),
  [#478](https://github.com/kody-hq/kody/pull/478),
  [#479](https://github.com/kody-hq/kody/pull/479))
- **Packages:** Adds debug traces. Recent runs and retained logs are available
  for package exports, workflows, subscriptions, jobs, services, apps, and
  retrievers. ([#423](https://github.com/kody-hq/kody/pull/423))
- **Packages:** Lets saved packages call Kody `search` and `execute` from
  `codemode`. ([#419](https://github.com/kody-hq/kody/pull/419))
- **Orgs:** Adds usernames. You can set a unique username on your account page,
  and it becomes your display name. You can also delete your account.
  ([#451](https://github.com/kody-hq/kody/pull/451),
  [#418](https://github.com/kody-hq/kody/pull/418))
- **Credentials:** Adds `secretHeaders.basic(...)` and
  `oauthClientCredentials(...)` so secret-aware fetch builds Basic Auth and
  client credentials headers from saved secrets.
  ([docs](https://kody.codes/docs/secrets),
  [#452](https://github.com/kody-hq/kody/pull/452))
- **Credentials:** Lets saved integrations store their authorize URL, scopes,
  and extra authorize params for reconnects.
  ([#469](https://github.com/kody-hq/kody/pull/469))
- **Automations:** Adds `includeCode` to `job_get` to return a job's published
  source, and gives package workflows access to attached remote connector tools.
  ([#431](https://github.com/kody-hq/kody/pull/431),
  [#433](https://github.com/kody-hq/kody/pull/433))
- **Apps:** Returns clear HTML or JSON errors when a package app fails, telling
  setup problems apart from package crashes and pointing to debug runs.
  ([#426](https://github.com/kody-hq/kody/pull/426))

## Fixes

- **Packages:** Fixes published packages running against a stale copy of
  `kody:runtime`, including nested packages, and fixes several dynamic import
  and artifact loading failures.
  ([#439](https://github.com/kody-hq/kody/pull/439),
  [#456](https://github.com/kody-hq/kody/pull/456),
  [#457](https://github.com/kody-hq/kody/pull/457),
  [#458](https://github.com/kody-hq/kody/pull/458),
  [#459](https://github.com/kody-hq/kody/pull/459),
  [#437](https://github.com/kody-hq/kody/pull/437))
- **Packages:** Fixes large package publishes running out of memory.
  ([#440](https://github.com/kody-hq/kody/pull/440),
  [#427](https://github.com/kody-hq/kody/pull/427))
- **Email:** Fixes `email_reply` finishing silently when delivery failed. It now
  throws. ([#461](https://github.com/kody-hq/kody/pull/461),
  [#466](https://github.com/kody-hq/kody/pull/466))
- **Automations:** Fixes failed package workflow exports not showing as errors.
  ([#442](https://github.com/kody-hq/kody/pull/442))

## Breaking changes

- **Execute:** Built-in agent turns (`agent_chat_turn` and the streaming turn
  capabilities) and chat threads are removed. **Action:** build chat in a
  package that calls your model provider, using `search` and `execute` from
  `codemode`. ([#419](https://github.com/kody-hq/kody/pull/419))
- **Packages:** Saved package names must use your username as their scope.
  **Action:** set a username, then rename packages to `@your-username/...`.
  ([#454](https://github.com/kody-hq/kody/pull/454))
- **Apps:** Package app, package invocation, and remote connector public URLs
  are now scoped by username. **Action:** update bookmarks and connector configs
  to the new URLs shown in Kody.
  ([#453](https://github.com/kody-hq/kody/pull/453),
  [#445](https://github.com/kody-hq/kody/pull/445))
- **Credentials:** `/connect/secret` is removed. **Action:** create secrets at
  `/account/secrets/new`, which accepts the same non-secret query prefills.
  ([docs](https://kody.codes/docs/secrets),
  [#484](https://github.com/kody-hq/kody/pull/484))

## Try it

Ask your agent to call one of your packages from `execute` with
`packages.invokeChecked`, then read the run with the package debug traces.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
