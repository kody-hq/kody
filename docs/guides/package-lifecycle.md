---
id: package_lifecycle
title: Package lifecycle: reuse, execute, fork, or create
summary:
  Choose between invoking existing behavior, temporary execute exploration,
  forking a close public package, deferred workflows, and creating a durable
  repo-backed package; session/tool-only lane validates with `repoRunChecks`,
  git lane with local checks plus `packagePublishExternalPush`; when the host
  can run the CLI use `kody dev` / mocks / `--local` before publish.
category: platform
---

# Package lifecycle: reuse, execute, fork, or create

Use this guide to decide whether to reuse existing behavior, explore with
`execute`, or create durable repo-backed package code. Use it before scheduling
new package behavior.

Also watch:

- [Build a Software Pipeline: Help your agent help you](https://www.youtube.com/watch?v=WjogtbCssZc),
  with the written app guide in [Package apps](./package-apps.md).
- [Share and fork community packages — then adapt them with your agent](https://www.youtube.com/watch?v=vZecfnLjEXA)
  for the public-package path.
- [Kody enables awesome triage-to-production workflows](https://www.youtube.com/watch?v=aySqbxQo9lM).

## Choose the smallest durable surface

### Invoke an existing package or capability

Search first. If a built-in capability or saved package already does the work,
invoke it instead of creating another implementation.

- Call discovered built-in capabilities through `kody` in `execute`.
- For a saved package export whose package name is known when the code is
  written, use a static `kody:@scope/package/export` import — the default for
  package reuse from `execute` and from other packages. Ad hoc execute bundles
  per call, so static imports from execute always see the current published
  version.
- When the target's name is data, use `import(specifier)` for a caller-owned or
  forked module. Exactly-once work uses workflows.

This is the default for an established operation whose behavior should stay
owned by its existing capability or package.

### Use `execute` for temporary one-off exploration

Use `execute` when the code is disposable: inspect an API response, test an
assumption, transform a small result, or run a one-time operation after any
required confirmation.

Keep the module focused and return structured evidence. Do not treat the
ephemeral module as the durable source for behavior that must be maintained,
reused, or evolved.

Ad hoc `execute` runs with the signed-in user's ambient authority: it can call
discovered capabilities through `kody`. A saved package is the
declared-authority unit. Secret mounts, host approval, integration allowlists,
and `kody.dependencies` are the request, and agents cannot widen those. Outbound
emissions (email, paid APIs, third-party writes) are not invertible; use a
package `dryRun` and fresh user confirmation before a live mutation.

### Fork a close public package before creating

<details>
<summary>What's the difference between forking and sharing?</summary>

**Fork** copies a public package so the other person owns and adapts that copy.
**Granting access** leaves one live package in the owner's org; the collaborator
connects to that org to read and run it. See
[Share a package](/docs/package-sharing) for grants, invites, and what a
collaborator can do.

</details>

Public packages in the Community catalog are excluded from general `search`.
When you need durable reusable behavior and nothing in the user's account fits,
call `communitySearch` for a close public package. If the other person should
use your live package instead of their own copy,
[grant them access](/docs/package-sharing).

If a public package is close to the user's goal:

1. Inspect it with `communityGet`.
2. Fork with `communityFork` (or point the user at one-click install on the
   package page).
3. Review the forked source, adapt it to the user's intent (including human
   `README.md` / `## Intent` and agent `AGENTS.md`), then publish. Publish
   checks require both files.

Do not reimplement from scratch when a public package is already close. Create a
new package only when no suitable public package exists.

### Create a repo-backed package

Create or extend a saved package when behavior is reusable, expected to evolve,
or needs a named package-owned schedule that evolves with its implementation,
and no suitable public package (or existing saved package) covers it. If the
implementation needs a library that does not fit a Worker isolate, keep this
package as the orchestrator and offload the heavy process — see
[Offload work that does not fit a Worker isolate](./heavy-work-offload.md). The
repo rooted at `package.json` is the durable source of truth. Package exports
form the callable surface, while jobs, subscriptions, retrievers, and apps
remain package-owned behavior.

Recurring schedules belong on a saved package under `package.json#kody.jobs`.
Deferred one-shot work uses `workflows.create({ runAt })` from `execute` or
package runtime. See [Workflows](../use/workflows.md).

Use `guide: "package_authoring"` for package shape, required `README.md` +
`AGENTS.md`, README `## Intent`, per-export JSDoc (search Purpose), visibility
guidance (personal-details hygiene before going public), and the secret-using
package approval checklist (`pending_secret_package_approvals` is non-null only
for unadopted community-forked packages; prefer the `communityForkAdopt` website
adoption link after review, or bulk approval URLs when present). Use
`guide: "package_apps"` when authoring or debugging a hosted package app,
community fork of an app, or session handoff. Use `guide: "platform_efficiency"`
for the unique Dynamic Worker day cost model (stated once; not copied into
package docs).

When the OAuth token is coarser than the intended export — Gmail can send
whenever it can create a draft — publish a thin package that only performs the
allowed call, then lock it. Load `locked_gmail_drafts` for that pattern.

## Signals to escalate from `execute` to a package

Move the behavior into a package when one or more of these become true:

- the user will run it again or other package code should reuse it
- it needs a named package-owned schedule that should evolve with the
  implementation, or another durable surface such as a subscription, service,
  app, workflow entrypoint, or package-owned storage
- the logic needs tests, multiple files, dependencies, review, or version
  history
- inputs, output, error handling, or integration behavior will evolve
- a one-off script has already been copied, repaired, or rerun
- you are calling a third-party **product** API with raw integration auth
  helpers (`createAuthenticatedFetch` or equivalent) beyond a cheap smoke test —
  **integrations = auth; packages = how agents should call the product**. Search
  for an existing wrapper package first, then `communitySearch`, then fork or
  create a thin helpers package

Do not create a package merely to wrap one clear call to an existing capability
or package export. One-shot reminders and deferred work belong in workflows, not
a new package.

## Choose an authoring lane

### Git lane for coding agents

When a normal filesystem and git client are available:

1. Call `packageGetGitRemote`. Scope defaults to write when you have write
   access, otherwise read; pass `scope` explicitly to force either. For a new
   package, pass `create: true`, `kody_id` set to the `@owner/leaf` name (or the
   name leaf), and `description` (at most 200 characters; a short public
   tagline); for an existing package, omit `create` and pass `kody_id` or
   `package_id` when the name is not known.
2. Run the returned setup commands and clone into a temporary directory. Those
   commands set local git `user.email` and `user.name` from `git_author` (the
   signed-in Kody account). Do not invent a git identity.
3. Edit and test through the normal local development loop (`kody dev` /
   `kody dev check` when the CLI is available).
4. Commit and push the package repository.
5. Publish the pushed head with `packagePublishExternalPush`. That call runs the
   server-side publish checks (manifest, docs, bundle, typecheck, lint,
   credentials). Do **not** open a repo session to run `repoRunChecks` on the
   pushed tree — `repoOpenSession` refuses unpublished HEAD, so the session
   cannot see that commit.

This lane supports binary assets, multi-file changes, local tests, and normal
git review.

### Tool-only lane

Without local filesystem or git access (for example ChatGPT, Claude, or Grok
mobile apps that only expose MCP):

1. Create the complete UTF-8 text package with `packageSave`, or inspect
   existing package metadata with `packageGet`. For `README.md`, `AGENTS.md`,
   and source, open a repo session (`repoOpenSession` + `repoReadFile`; `path`
   accepts `#L165`, `#L165-L180`, or a Markdown heading slug) or one file with
   `search({ entity: "package:{id}#{path}" })`.
2. Use `repoEditFiles`, `repoCommit`, and **`repoRunChecks`** for repo-backed
   edits and validation. `repoRunChecks` is the MCP-only safety gate before
   publish: manifest, docs, dependencies, bundle, typecheck, lint, and
   credential-need validation — without requiring a local CLI.
3. Publish with `repoPublishSession` only after `repoRunChecks` returns `ok`.

If the work needs binary assets, broad refactors, or a substantial local
build/test loop, explain that it fits a coding-capable agent and confirm before
continuing in the tool-only lane.

## Validate and test before publish

Every authoring lane must validate before publish. The gate depends on the
**lane**, not only whether a shell exists:

| Lane / host                                  | Before publish                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tool-only / session** (MCP, no local git)  | `repoRunChecks` on the active repo session — required. Then `repoPublishSession`. No local mock runtime.                                                                                                     |
| **Git lane** (filesystem + git)              | Local tests (`kody dev` / `kody dev check` when CLI available), push, then `packagePublishExternalPush` (server-side publish checks). Do **not** require `repoRunChecks` — sessions refuse unpublished HEAD. |
| **CLI extras** (Node ≥22 + `@kodycodes/cli`) | Optional unpublished surface tests below (`kody dev`, `.kody/mocks.ts`, `execute --local` / `--target mock`) on top of the lane gate above.                                                                  |

Do **not** assume every agent can run the CLI. Mobile MCP-only agents stop at
`repoRunChecks`, then publish, then use post-publish smoke surfaces
(`packageAppFetch`, `packageSubscriptionDispatch`, webhook synthetic dispatch,
or a static `kody:@…` import from `execute` when that tool is available on the
session).

### Local CLI testing (when the host can run code)

When Node ≥22 and `@kodycodes/cli` are available, use `kody dev` from the
package directory to exercise unpublished surfaces before the first publish. One
`--target prod|mock` switch decides where server-side calls go (default **`mock`
for `kody dev`**, **`prod` for `execute` / `search`**).

| Surface           | How to test locally                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exports**       | `kody execute --target mock --invoke ./export --params '…'` (or `--file`) against the working tree; then `--target prod`                                 |
| **Apps**          | `kody dev` / `kody dev fetch /path` (`--json` for agents) — see [Package apps](./package-apps.md#local-testing-with-kody-dev)                            |
| **Schedules**     | `kody dev job <name>` — runs the job entry **once** with the scheduler’s no-arg contract; never schedules locally                                        |
| **Webhooks**      | `kody dev webhook <name> --body fixture.json` — delivers the platform webhook envelope                                                                   |
| **Subscriptions** | `kody dev emit <event> --body event.json` — delivers the platform subscription envelope (`synthetic: true`); on mock, any declared event type is allowed |
| **Check**         | `kody dev check` — local bundles, then the same publish checks publish runs (`packageCheck`); `--offline` skips the server checks                        |

Mock first (safe iteration; scratch `packageStorage` for the working tree; fake
or local credentials), then re-run with `--target prod` for real CapabilityProxy
hops before publish. `--target prod` still does **not** attach hosted
`packageStorage` / `packageSecrets` to the working-tree package — publish (or
import a published dep) for those. See the
[target table in Package apps](./package-apps.md#local-testing-with-kody-dev).
Share previews for unpublished packages are out of scope. `execute --local`
without `--target` talks to the hosted account.

```bash
cd ./my-package
npx @kodycodes/cli@latest dev check
npx @kodycodes/cli@latest execute --target mock --invoke ./scheduled-report
npx @kodycodes/cli@latest dev job heartbeat
npx @kodycodes/cli@latest dev webhook ping --body ./fixtures/ping.json
npx @kodycodes/cli@latest dev emit user.deleted --body ./fixtures/user-deleted.json
```

### Mock outbound `fetch` with `.kody/mocks.ts`

Optional, **CLI hosts only**. Under `--target mock` only, put MSW handlers in
the package at `.kody/mocks.ts`. Package code still runs in workerd; the CLI’s
Node-side gateway matches outbound fetches against those handlers (no patching
inside workerd). Without the file, mock is **not** offline: ambient / gateway
fetch uses public-network passthrough (private hosts still need
`--allow-private-network`); authenticated fetch stays fail-closed. The file is a
local-dev hook — not a publish entrypoint, ignored on `--target prod` — but
git-tracked paths under `.kody/` still ship in the published source snapshot.
Gitignore local-only mocks or deps maps (or `git rm --cached` if already
tracked). MCP-only agents cannot load this file; they rely on `repoRunChecks`
and post-publish smokes instead.

```ts
// .kody/mocks.ts
import { http, HttpResponse } from 'msw'

export const handlers = [
	http.get('https://api.example.com/v1/me', () =>
		HttpResponse.json({ id: 'user_mock', name: 'Mock User' }),
	),
]
```

```bash
npx @kodycodes/cli@latest execute --target mock --invoke ./export --params '…'
npx @kodycodes/cli@latest dev --passthrough api.stripe.com
```

Unmatched requests fail closed with structured `unmocked_request` (method + URL)
and a paste-ready handler stub in `fix` / `details.handlerStub`.
`--passthrough <host,…>` opts specific hosts into the real network; credentials
stay fake on mock, so passthrough never carries real credentials. Private/local
passthrough hosts also need `--allow-private-network`.

Example agent-facing error:

```text
[unmocked_request] Unmocked GET https://api.example.com/v1/me under --target mock.
target: mock
where: GET https://api.example.com/v1/me
fix: Add a handler in .kody/mocks.ts (or pass --passthrough api.example.com for real network without real credentials):

import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get("https://api.example.com/v1/me", () =>
    HttpResponse.json({ /* TODO */ }, { status: 200 }),
  ),
]
```

## Test the scheduled wrapper before enabling its schedule

Scheduled behavior should not be its first real execution. When the CLI is
available, prefer
[`kody dev job`](#local-cli-testing-when-the-host-can-run-code) while
unpublished. Without the CLI, publish first — session/tool-only lane:
`repoRunChecks` then `repoPublishSession`; git lane: push then
`packagePublishExternalPush` (do **not** use `repoRunChecks` on an unpublished
push; `repoOpenSession` refuses that HEAD) — then call the published `execute`
import below before enabling the schedule. Package job manifests do not supply
params to their entrypoints, so structure the package with:

- a shared implementation that accepts explicit input
- an optional callable export that passes representative input to that
  implementation
- a no-argument scheduled wrapper that loads its own current configuration and
  calls the same implementation

Make the no-argument scheduled wrapper callable through `package.json.exports`,
point the package job entry at that wrapper, and initially declare the
package-owned job with `"enabled": false`.

After package checks and publishing succeed:

1. Inspect the published package and export contracts.
2. Call the scheduled wrapper from authenticated `execute` with a static import
   and no extra arguments. This verifies the same no-input contract the
   scheduler uses.
3. Optionally invoke the underlying callable export with representative input:
   realistic field shapes, boundary values, and the same configuration
   references the wrapper will load. Never put plaintext credentials in params.
4. Validate the structured results and the intended durable or external effects.
   Exercise an expected failure path when the operation is risky.
5. Only then call `jobUpdate` with `enabled: true`, and verify the package/job
   detail reflects the enabled schedule.

   Republishing never flips an existing job's runtime `enabled` flag (manifest
   `enabled` is create-time only) and does not insert or reactivate owner cron
   enablements for a disabled job. Use `jobUpdate` / `enablementEnable` (or a
   package pause/resume export) to change enabled state after create. This keeps
   fleet-wide package publishes (codemods, stamp migrations) from silently
   stopping — or re-enabling — a sweeper an operator already toggled.

Example test call:

```ts
import scheduledReport from 'kody:@kentcdodds/daily-report/scheduled-report'

export default async function main() {
	return await scheduledReport()
}
```

For exports that send messages, write remote records, charge accounts, or make
other external mutations, prefer a package-specific `dryRun` input. Implement it
so the export performs validation and returns a preview while skipping the
mutation. Include intent-critical mode fields in that preview (reply vs new
post, send vs draft, and similar) so confirmation is about what will happen, not
only that validation passed. Validate live and dry-run inputs at the **export**
entrypoint with the same strict contract — see
[Runtime input checking](./package-authoring.md#runtime-input-checking) (exposed
exports only; internal helpers can rely on TypeScript). `dryRun` is a package
contract, not an automatic Kody runtime flag; test the dry-run path first.

Immediately before any live external mutation, obtain explicit user confirmation
that identifies the target and scope of the mutation. Do not infer confirmation
from an earlier request, a successful dry run, or the agent's own assessment.
After confirmation, perform only the confirmed call, then report the result.
Require fresh confirmation if the target or scope changes.

Keep the schedule disabled when representative testing is inconclusive,
credentials or host approval are missing, the result is unexpected, or the live
mutation has not been explicitly confirmed by the user.

## Delete a package

`packageDelete` permanently removes a saved package the signed-in user owns. Do
not call it because a package is unused, failing, or over quota unless the owner
explicitly asked to delete that package.

1. Load the package with `packageGet` or `packageList`.
2. Show the owner the package name and that delete removes jobs, storage,
   secrets, tokens, the catalog entry if one exists, and Artifacts repos.
   Existing forks of that public package keep their copies. A community fork
   record for the deleted package itself is removed. This cannot be undone.
3. Wait for the owner to type the package name.
4. Call `packageDelete` with the scoped name (or `package_id` when the name is
   not known) and `confirm_name` matching that name exactly. The capability
   refuses and names the expected value when `confirm_name` is missing or wrong.

People can delete from `/@username/{package-name}/settings`: choose **Delete
package**, then type the package name in the modal.

Hiding (`packageUpdate` `changes.hidden`) and making a package private are not
deletion.

## Evolve the durable behavior

For later changes, inspect the current repo, preserve the package's intent,
update tests and docs with the implementation, and repeat the disabled
schedule/export test when the scheduled path or its inputs change. Publish only
checked commits; do not patch generated runtime state as a substitute for
changing the package source.
