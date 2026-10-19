---
id: package_authoring
title: Package authoring
summary:
  START HERE when creating or materially changing a Kody package: package
  shape, required README.md (human) and AGENTS.md (agent), README Intent
  section, per-export JSDoc (search Purpose), strict runtime input
  checking for agent-facing exports, personal-details hygiene before going
  public, secret-using package approval checklist, and scope-update
  guidance without adding new primitives.
category: platform
---

# Package authoring

Use this guide when creating a new Kody package or materially changing an
existing one.

A package is not done until root `README.md` and `AGENTS.md` are both present
and non-empty, README `## Intent` is current, every public export has JSDoc as
specified in [Export JSDoc](#export-jsdoc), and the smoke tests in
[Verify your publish](#verify-your-publish) pass (or the user explicitly skips a
surface). Publish checks fail when either file is missing or empty.
Already-published packages keep running as published; the next author-driven
publish requires both files.

Unique Dynamic Worker days and how the acting user plus a stable module graph
reuse one isolate per UTC day are documented once in
[Platform efficiency](./platform-efficiency.md) (`guide:platform_efficiency`).
Package README and AGENTS.md files do not repeat that cost model.

## Choose an authoring lane

There are two lanes for writing package source. Pick based on whether you have
local filesystem and git access:

- **Git lane (coding agents — preferred).** Call
  `packageGetGitRemote({ create: true, kody_id: '@owner/leaf', description })`
  (or the name leaf as `kody_id`) to register a stub saved package and mint a
  short-lived authenticated remote in one call (for existing packages, omit
  `create` and pass the scoped name, or `package_id` when the name is not
  known). Run the returned `setup_commands` to clone into a temporary directory
  — they set local `git config user.email` / `user.name` from `git_author` (the
  signed-in Kody account). Do not invent or guess a git identity. Edit normally
  — binary assets, multi-file refactors, and local build/test loops all work —
  commit, push, then publish with `packagePublishExternalPush`. If that tool
  returns `locked`, open the returned `approval_url` so the owner can promote
  the named commit. Do not treat HEAD as live until `published_commit` moves.
  When the OAuth token is coarser than the export (Gmail drafts without send),
  lock after the first publish — see
  [locked-gmail-drafts.md](./locked-gmail-drafts.md).
- **Tool-only lane.** Without local filesystem/git access (MCP-only agents such
  as ChatGPT / Claude / Grok mobile apps), create with `packageSave` (complete
  UTF-8 text file set; no binary files) and edit through repo sessions
  (`repoOpenSession`, `repoEditFiles`, `repoCommit`, then **`repoRunChecks`**
  before `repoPublishSession`). `repoRunChecks` is the pre-publish validate for
  hosts that cannot run the CLI. When a coding agent _can_ run `@kodycodes/cli`,
  also use `kody dev` / `.kody/mocks.ts` / `--local` as optional local surface
  tests — see `guide:package_lifecycle`.

If a request needs binary assets, many-file changes, or local build/test loops
and you are tool-only, tell the user the task fits a coding-capable agent better
and confirm before proceeding.

## Package docs (`README.md` + `AGENTS.md`)

Publish requires two non-empty root files. They are not interchangeable. Package
docs and export JSDoc are two layers of progressive disclosure for agent
guidance; see [Where agent guidance lives](./agent-guidance.md) before stuffing
package specifics into memories or MCP server instructions.

- **`README.md`** — human-focused. What the package does, who it is for,
  prerequisites, setup, and how a person knows it is working. Include a concise
  `## Intent` section. Do not treat this file as the agent runbook.
- **`AGENTS.md`** — agent-focused. Imports, smoke-test calls, edge cases, and
  other notes an agent needs to use or change the package. Do not dump that
  runbook into `README.md`.

Repo checks (`repoRunChecks`, `repoPublishSession`,
`packagePublishExternalPush`) fail with a `docs` check when either file is
missing or empty. Community install and platform codemods do not apply this
gate, so existing listings stay forkable. The next author-driven publish of a
package must add both files.

New stubs from `packageGetGitRemote` (`create: true`) include placeholders for
both files. Replace those placeholders before the first real publish.

## README Intent section

Package intent is human-authored guidance, not a Kody primitive. Keep it in the
root `README.md` so people (and search detail) see why the package exists.

When you create or materially change a package:

1. Include or maintain a `## Intent` section in `README.md`.
2. Capture the user's goal in a few concrete sentences.
3. Ask the user when the intent is unclear or underspecified.
4. Update the intent only when you are confident the goal changed.
5. If the user expands the package scope, update the section with the new scope.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track intent.

README Intent is package-level. It does not replace per-export JSDoc. Search
shows Intent and an Exports Purpose column side by side; Purpose comes from each
export's JSDoc, not from this section.

## Minimal shape

```md
# Package Name

## Intent

This package exists to ...
```

Keep the section concise. It should explain why the package exists and what
success means for the user, not duplicate every implementation detail.

`AGENTS.md` is a separate root file. A typical stub:

````md
# Package Name

## Imports

```ts
import main from 'kody:@scope/id'
```

## Smoke tests

Before publish (`guide:package_lifecycle`): session lane — `repoRunChecks` then
`repoPublishSession`; git lane — local checks, push, then
`packagePublishExternalPush` (sessions refuse unpublished HEAD). After publish,
when Node ≥22 and the CLI are available, prefer local CLI execute
(`guide:local_execute`). MCP-only hosts smoke with the matching post-publish
surface (`packageAppFetch`, `packageSubscriptionDispatch`, webhook synthetic
dispatch) or a static `kody:@…` import from `execute` when that tool is on the
session.

## Edge cases

On exposed exports that publish or send, reject unknown input keys; see
`guide:package_authoring#runtime-input-checking`.
````

## Export JSDoc

Search detail (`entity: "package:…"`) shows an Exports table whose **Purpose**
column comes from each export's JSDoc. When JSDoc is missing, Purpose falls back
to the generic string `Package export.` Agents skim that column first when
choosing among sibling exports. Export-specific limits and call gotchas belong
here, not in MCP server instructions or account memories
([Where agent guidance lives](./agent-guidance.md)).

TypeScript types and the export name give call shape when present. They do not
say **when** or **why** to pick one export over another, and on exposed exports
they do not protect callers who pass plain objects through `execute` (see
[Runtime input checking](#runtime-input-checking)). README `## Intent` is
package-scoped and often does not name every export. Neither replaces per-export
JSDoc.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track export purpose. Put it in JSDoc on the exported
function.

When you create or materially change a public export:

1. Write JSDoc immediately above the exported function (or above
   `export default` for a local binding in the same file).
2. Start with one line that states **what** the export does and **when** to call
   it.
3. Add `@param` for each input.
4. Add `@returns`.
5. Add `@example` that **imports** `kody:@scope/id/export` and **calls** it.

If the export's `package.json` `exports` entry has a `types` condition, put the
JSDoc on that types file — search reads the types module when it exists. JSDoc
on an imported re-export (`export default foo` where `foo` is imported) is not
attributed; implement the function in the export file (or a local binding in
that file) so the comment sits on the exported symbol.

```ts
/**
 * Format a Discord moderation report for a channel.
 * Use when a human or job needs a readable summary of recent flags.
 *
 * @param input - Channel id and optional lookback window
 * @returns Markdown report body
 *
 * @example
 * import formatReport from 'kody:@scope/discord/format-report'
 *
 * const report = await formatReport({ channelId: '123' })
 */
export default async function formatReport(input: {
	channelId: string
	lookbackHours?: number
}): Promise<{ markdown: string }> {
	return { markdown: '' }
}
```

Treat missing or generic Purpose (`Package export.`) as unfinished work, the
same as a missing README `## Intent` section.

## Runtime input checking

This rule applies to **exposed exports** — the package surface agents call
through `execute` with plain objects. Internal helpers and modules can rely on
TypeScript; do not prescribe Remix Schema or fail-on-unknown for internal code.

On those export boundaries, TypeScript types do not run at call time, so a
guessed or mistyped key is easy to ship. For exports that publish, send, write
remote records, or otherwise change external intent, validate inputs at runtime
and prefer one clear contract.

1. **Fail on unknown keys (strict).** At the export entrypoint, parse the call
   object with a schema that rejects unrecognized fields. Prefer
   [`remix/data-schema`](https://www.npmjs.com/package/@remix-run/data-schema)
   over Zod when choosing a schema library for those boundaries (smaller and
   faster in Worker isolates). Remix Schema's `object()` strips unknown keys by
   default — pass `{ unknownKeys: 'error' }` for agent-facing export inputs:

   ```ts
   import { object, optional, parse, string } from 'remix/data-schema'

   const createPostInput = object(
   	{
   		text: string(),
   		reply: optional(
   			object({ in_reply_to_tweet_id: string() }, { unknownKeys: 'error' }),
   		),
   	},
   	{ unknownKeys: 'error' },
   )

   export default async function createPost(raw: unknown) {
   	const input = parse(createPostInput, raw)
   	// …
   }
   ```

2. **Do not silently strip unknown params when a wrong key could change
   intent.** Examples: reply vs new post, send vs draft, update vs create. If
   the caller meant something the schema does not accept, reject with an error
   that names the unknown key and the accepted shape. Silent drop turns a wrong
   call into a successful action with the wrong meaning.

3. **One documented contract — no alias sprawl.** Prefer a single canonical
   field name. If a package intentionally accepts a synonym, map it explicitly
   in code and document that mapping in export JSDoc (and `AGENTS.md` when it is
   an agent gotcha). Do not invent broad alias or compat layers for guessed
   keys.

4. **Surface intent-critical mode in dry-run and confirm results.** When the
   export supports `dryRun` (or similar preview) or returns a confirmation
   payload, include the fields that show what will happen — for example that
   this is a reply to a specific id, or a new standalone post. Agents and humans
   confirm mode from that result, not from the raw input alone. See
   [Package lifecycle](./package-lifecycle.md) for when to use `dryRun` before
   live mutations.

Document the accepted input shape in export JSDoc `@param` / `@example`. Put
agent-facing gotchas (strict keys, dry-run mode fields) in `AGENTS.md`.

## Package app routing

Hosted-app session handoff, `packageAppFetch` smoke tests, asset URLs, and lean
forks are the [Package apps](./package-apps.md) playbook (`guide:package_apps`).
This section is the mount-prefix recipe those pages share.

Production-hosted package apps live at
`https://{username}.kody.run/packages/<package-name>/<path>` (the username is in
the hostname; the path mount is `/packages/<package-name>`). Confirmed
non-production runtimes may serve inline on the app origin at
`/@username/packages/<package-name>/<path>` instead.

Every package app receives only `/<path>` after the host strips the mount.
Root-relative links such as `/audio/123` therefore escape the mount and are not
routed back to the package app. Import `packageContext` from `kody:runtime` and
build every in-app link, redirect, share/email URL, and OAuth callback against
its public base. A Remix recipe that prefixes its route contract remounts the
Request in the entry; see [Package apps](./package-apps.md#remix-recipe).

```ts
import { packageContext } from 'kody:runtime'
import { form, route } from 'remix/routes'

export const routes = route(packageContext?.appBasePath ?? '', {
	home: '/',
	notes: form('notes'),
})
```

A fetch handler builds those URLs itself:

```ts
import { packageContext } from 'kody:runtime'

if (!packageContext?.hostedUrl) {
	throw new Error('This module must run as a package app.')
}

const audioUrl = new URL(
	`${packageContext.appBasePath}/audio/123`,
	packageContext.hostedUrl,
)
```

- `packageContext.hostedUrl` is the full public URL of the app mount.
- `packageContext.appBasePath` is the origin-relative mount path
  (`/packages/<package-name>` on a subdomain,
  `/@username/packages/<package-name>` when inline).

Kody derives both fields from the package's current serving username and package
name leaf, including after a rename or fork. Do not hard-code either path
segment.

## `kody.description` (short public tagline)

`package.json#kody.description` is a **short public tagline**, not a feature
dump. Aim for about **80–120 characters** (hard max **200**). Prefer outcome
phrasing such as “Send transactional email via Resend” over inventory lists of
exports, auth, or APIs.

Put feature lists, API surface, auth notes, and longer human guidance in
`README.md` (including `## Intent`), agent runbooks in `AGENTS.md`,
`kody.searchText`, and [export JSDoc](#export-jsdoc) — not in
`kody.description`. Catalog cards and Open Graph share cards reuse this field,
so keep it concise.

## `kody.category` (community browse)

The Community catalog browses public packages by a closed category. Set
`package.json#kody.category` to one of `integrations`, `examples`,
`productivity`, `apps`, or `utilities` before making the package public. When
the field is omitted, Kody infers a category from well-known tags such as
`github` or `zero-auth`, or files the package under Other. Tags stay freeform
search keywords; do not use `kody.tags` as a second category vocabulary.

## Package visibility

New packages are always **private**. Visibility is a repo setting
(`packageUpdate` `changes.visibility` or `repoUpdate`), not
`package.json#private`. Ignore leftover `"private"` in manifests.

- Public means default-branch HEAD is world-readable and forkable and the
  package appears on `/community`.
- Private is owner-only. Going private 404s public URLs; existing forks keep
  their copies. Type the package slug to confirm (`confirm_name` for agents).
- There are no MIT, logo, or README Intent **platform** gates to become public.
  Agents run a personal-details hygiene pass before flipping public (below). The
  Worker does not scan or block on that review. Publishing a version requires
  non-empty root `README.md` and `AGENTS.md` (see
  [Package docs](#package-docs-readmemd--agentsmd)).

### Personal-details hygiene before going public

Before calling `packageUpdate` with `changes.visibility: "public"` or
`communityPublish`, review source, README, Intent, description, tags, examples,
and hardcoded identifiers for overly personal material.

Treat as personal or too household-specific:

- home addresses, private emails, phone numbers, family names
- personal Discord or channel IDs
- private calendar habits
- one-off personal automation that only makes sense for one household
- secrets, tokens, and internal-only URLs

If the package is clean, proceed.

If anything looks personal or hyper-specific to one person or household, **do
not publish yet**. Tell the user what you found. Suggest how to generalize:
parameterize identifiers, use secrets or integrations instead of hardcoded
credentials, rename examples, strip PII, and keep a private fork for personal
wiring. Wait for explicit go-ahead before flipping public.

## Work that does not fit a Worker isolate

Package checks and publish rebuilds bundle every declared npm dependency inside
a short-lived isolate. A large graph (PDF.js / `unpdf`, native addons, browsers,
big WASM) can fail with an isolate memory or CPU reset even when the same import
works in ad hoc `execute`.

Do not vendor the library, switch to a dynamic import, or skip checks. Keep the
Kody package as a thin orchestrator and run the heavy work in a process the
owner operates. Open `search({ entity: "guide:heavy_work_offload" })`.

## Secret-using packages

Password-manager items use [custom secret providers](./secret-providers.md)
(`{{secret/<provider>:<ref>}}` and `kody.secretProvider`); that path is separate
from user-secret grants.

When a package will use user-scoped secrets (`{{secret:name}}` placeholders or
`kody.secretMounts`):

1. Ensure each secret exists (open `search({ entity: "guide:connect_secret" })`
   / `search({ entity: "guide:secret_backed_integration" })`). New secrets
   default to **headers-only** fill placement; set `placement` on `secretSet`
   (or edit fill placement on the credential) when the package fills query,
   path, or body. Prefer `x-kody-secret-resolution: headers-only` on fetches
   whose body forwards untrusted text — that header intersects placement and
   never widens it. `kody dev check` / publish warn when a fetch body is dynamic
   and headers come from a variable or spread without that mode.
2. Self-authored packages and community forks the owner adopted on the website
   after a real source review get automatic read/use access to user secrets
   (host approval still applies; `secretSet` / `secretDelete` still need an
   `allowed_packages` grant). After save/publish, read
   `pending_secret_package_approvals` from the tool result — it is non-null only
   for unadopted community forks.
3. When pending approvals are present, either review the fork source and send
   the user the `approval_url` from `communityForkAdopt` (only the owner can
   adopt, on the website), or send the user `bulk_approval_url` / each
   `approval_url`.
4. Wait for approval or adoption (when required), then smoke-test from `execute`
   with a static `kody:@scope/package/export` import. Use a read-only export or
   a package-supported dry-run input that actually reads the approved secret
   (for example an authenticated read-only API call), so the smoke test proves
   secret access without external side effects. Dependents compose the same way:
   they statically import the export; the stamp uses the owning package's grants
   and `kody.secretMounts` without adding the dependent to `allowed_packages`.
5. Only then treat the package as ready to run.

Fill placement details: [Credentials](./credentials.md#keys-and-placeholders)
and [Secrets](./secrets.md).

Host approval (from an earlier ad hoc `execute` smoke test) is separate from
package approval. Unadopted community-forked packages may need both;
self-authored and adopted packages still need host approval when outbound calls
require it.

## Cross-package composition

Call another package export the same way search entity detail shows: import it,
then call it.

- **Name known when you write the code** → static import, and list the package
  in `package.json#kody.dependencies` when the call site is package source:

  ```ts
  import sendMail from 'kody:@scope/mailer/send'
  await sendMail({ to, subject, text })
  ```

- **Name is data** (route table, config string, runtime choice) → computed
  dynamic import:

  ```ts
  const mod = await import(specifier) // "kody:@scope/package/export"
  await mod.default(params)
  ```

- **Exactly-once** → [workflows](../use/workflows.md), not a keyed invoke.
- **External HTTP clients** → [inbound webhooks](../use/webhooks.md).

README, `AGENTS.md`, and export `@example` blocks follow the same rules: import
and call. Do not demo a `packages` helper. Package codemod
`0008-packages-invoke-to-static-import` rewrites literal call sites and
parseable Markdown examples; ambiguous or keyed sites need a manual edit as
above.

## Ship Agent Skills

Put `skills/<name>/SKILL.md` (with `name` and `description` frontmatter) in the
package. Publish validates it and a malformed skill fails the publish. See
[Ship Agent Skills in a package](./package-skills.md) (`guide:package_skills`).

## Verify your publish

After publish succeeds — and after any required secret approvals — confirm every
export's search Purpose is real JSDoc (not `Package export.`; see
[Export JSDoc](#export-jsdoc)), then run synthetic smoke tests for every
declared surface before calling the package complete. Synthetic invocations are
real-surface runs with real side effects; use a deliberately visible
irreversible-side-effect guard when a smoke test should stay safe.

1. Read `test_hints` on the `packagePublishExternalPush` result when present. It
   lists copy-pasteable calls for declared apps and subscription topics.
2. **Exports and secret mounts** — statically import
   `kody:@scope/package/export` from `execute` against a read-only export or
   package-supported dry-run input that exercises approved secrets (see
   [Secret-using packages](#secret-using-packages) above).
3. **Package apps** — `packageAppFetch` with the scoped name (or `package_id`
   when the name is not known), plus the path, method, and body your handler
   needs. Confirm `{ status, headers, body, truncated }` and any
   `packageStorage()` side effects. See
   [Package app fetch](../use/package-app-fetch.md) and the
   [Package apps](./package-apps.md) playbook (`guide:package_apps`).
4. **Subscriptions** — from interactive MCP, `packageSubscriptionDispatch` with
   the scoped name (or `package_id` when the name is not known), `topic`, and
   exactly one of `params` (fixture) or `email_message_id` (stored-mail replay)
   for each declared topic. This verifies the handler you just published. Reuse
   another package with a static `kody:@scope/package/export` import. See
   [Synthetic event dispatch](../use/synthetic-event-dispatch.md) and the
   [package subscriptions guide](./package-subscriptions.md#synthetic-dispatch).
5. Optional UI checks — open `hosted_app_url` when the publish response includes
   one; synthetic app fetches do not replace browser verification for layout,
   OAuth redirects, or websocket facets.

Only after `README.md` + `AGENTS.md`, README `## Intent`, per-export JSDoc, and
these checks pass (or the user explicitly skips a surface) treat the package as
ready to run.

## Package icon

Put the list/identity mark at `.kody/icon.png` (or `.kody/icon.svg`,
`.kody/icon.webp`, `.kody/icon.jpg`, `.kody/icon.jpeg`). Prefer a square visual
with a simple silhouette that remains legible at 56 pixels. Keep it under 2 MiB
and 16 megapixels. For a package that represents a product or service, use that
product's official logo. Kody stores a 256-pixel WebP derivative of that source
(or a generated package-name swirl when the repository has no icon).

`.kody/` is platform metadata, like `.github/`. Keep app PWA icons
(`icons/icon-192.png`, `public/`) in the product tree — they are not the list
mark.

Publishing or pushing the package indexes the mark from the published commit.
The first existing file wins in this order: `.kody/icon.*`, root `icon.*`, root
`community-icon.*` (svg, png, webp, jpg, jpeg in each group), then
`icons/icon-192.png` for package apps. When replacing an icon with a different
format (for example svg → png), delete the superseded file in the same commit or
the earlier path in that list keeps winning. `packageSave` is text-only; binary
icons arrive through the Artifacts git / publish path.
