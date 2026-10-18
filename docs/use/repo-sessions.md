# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly. Search `package:{id}#{subpath}` returns one export contract;
`packageGet` returns the full export array plus secret FYI. To read `README.md`,
`AGENTS.md`, or other package files, open a session with `repoOpenSession` and
call `repoReadFile`. `path` accepts a fragment: `#L165` (that line plus
surrounding context), `#L165-L180` (that inclusive range), or a Markdown heading
slug such as `README.md#export-jsdoc`. A missing anchor fails instead of
returning the whole file. The same fragments work on
`search({ entity: "package:{id}#{path}" })` when you only need one file.
One-shot reads should `repoDiscardSession` when finished.

## When to use repo sessions vs. a local git remote

There are two supported ways to edit repo-backed source:

- **Repo sessions** (`repoOpenSession` and the file-level `repo_*` session
  capabilities). Use these when you are a tool-only agent without a real
  filesystem, or when you only need structured file edits inside an isolated
  workspace. Package-owned jobs live in the same package repo — open the
  package, not a separate job source.
- **A short-lived authenticated git remote** via `packageGetGitRemote` plus
  `packagePublishExternalPush`. Use this when you have local filesystem and git
  access and want to clone the repo into a temp directory, edit normally, and
  push the resulting HEAD back. Commits use `git_author` from the remote result
  (the signed-in Kody account); do not invent a git email. This path is
  **saved-package-only**.

When you only need to inspect the current scheduled job source, call
**`jobGet`** with `includeCode: true`. The response includes the published
manifest-declared entrypoint path and source code, so you do not need to open a
repo session just to read the job module.

## File-level session API

Repo sessions expose a **file-level API**. There is no git-command channel:
branch, checkout, fetch, pull, push, and remote operations are not available
inside sessions. For saved packages, use `packageGetGitRemote` when you need
full git.

Merge drift from the published default branch is handled separately by
**`repoRebaseSession`**.

### Core edit and git-inspection capabilities

| Capability           | Purpose                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `repoEditFiles`      | Batch write, replace, writeJson, delete, or move edits (10 MiB per-file limit on content-changing results) |
| `repoApplyPatch`     | Apply a unified-diff patch (all-or-nothing)                                                                |
| `repoStatus`         | Git status for the session workspace                                                                       |
| `repoDiff`           | Git diff for uncommitted changes                                                                           |
| `repoLog`            | Commit history (`depth` optional)                                                                          |
| `repoCommit`         | Stage all changes and commit with a message                                                                |
| `repoRestore`        | Restore paths to content at a commit (default: session base)                                               |
| `repoRunChecks`      | MCP/tool-only pre-publish validate (manifest, typecheck, bundle, credentials, …)                           |
| `repoPublishSession` | Publish after checks pass                                                                                  |

### Unified-diff patch format

`repoApplyPatch` accepts a standard unified diff. Each file patch must include:

- a `--- a/<path>` line and a `+++ b/<path>` line (use `/dev/null` on either
  side to create or delete a file)
- one or more `@@ -<old>,<n> +<new>,<n> @@` hunk markers
- normal context (` `), removal (`-`), and addition (`+`) lines inside each hunk

Multiple file patches can be stacked back-to-back in one patch string. If you
have the full new file body, prefer a `write` edit in `repoEditFiles` instead of
hand-crafting hunks.

## Opening by package identity

`repoOpenSession` can open repo-backed packages by user-facing identity instead
of requiring the internal `source_id`. Prefer the scoped `@owner/leaf` name (or
the name leaf). Use `package_id` only when the name is not known, or for a
stable ref.

Example:

```json
{ "target": { "kind": "package", "kody_id": "@owner/leaf" } }
```

`kody_id` also accepts the name leaf (`"leaf"`). Use `package_id` only when the
name is not known, or for a stable ref:

```json
{ "target": { "kind": "package", "package_id": "…" } }
```

Pass `source_id` when you already have it, but most callers should prefer
`target`.

Pass `conversation_id` to resume that conversation's active session for the same
source. Omitting `conversation_id` always mints a new session:
never-checkpointed is not the same as abandoned, and concurrent callers of the
same source must not share a workspace that has not checkpointed yet.

## Structured repair detail

Publish-oriented repo flows return structured detail for important failure
states:

- **`checks_outdated`** when a session changed after the last successful check
- **`base_moved`** with `repair_hint: "repoRebaseSession"` plus both the session
  base commit and current published commit
- **`locked`** with `approval_url` when the package has `locked_at` set. The
  session commit is already on HEAD; promoting it is a website click at that
  URL. The `commit` query is the full 40-character SHA-1. Approving one commit
  does not unlock the package.

That makes it easier for agents to resume or repair a workflow without string
parsing.

## When to use other repo capabilities

Use the other repo capabilities when you need more control over the session:

- discover current sessions with `repoListSessions` before you know a
  `session_id`; it defaults to active sessions and can be filtered by `status`
  or `source_id`
- browse files with `repoTree` and `repoReadFile` (`path` may end in `#L165`,
  `#L165-L180`, or a Markdown `#heading-slug`)
- search the workspace with `repoSearch`
- inspect status with `repoGetCheckStatus`
- repair drift with `repoRebaseSession`

If you find an active session you no longer need, pass its `id` as `session_id`
to `repoDiscardSession` to close it. One-shot package helpers that open a
session to read or write should discard in a `finally` so leftovers do not
accumulate against the `repo_sessions` entitlement. Unused (never-checkpointed)
sessions are swept after 30 minutes idle; checkpointed sessions are swept after
7 days idle.

### `write` edits vs patches

A `repoEditFiles` `write` edit overwrites one file with full new content and
returns a per-file diff plus a `changed` flag. Reach for it when:

- replacing the entire body of a package export module, job module, or app
  server
- writing a freshly generated package file that does not yet exist
- patching a one-line config when you do not want to hand-craft a diff hunk

It only mutates the live session overlay. Pair it with `repoCommit`,
`repoRunChecks`, and `repoPublishSession` when you are ready to publish.

```json
{
	"session_id": "session-1",
	"edits": [
		{
			"kind": "write",
			"path": "src/index.ts",
			"content": "export default async function main() { return { ok: true } }\n"
		}
	]
}
```

## Example

```ts
const session = await kody.repoOpenSession({
	target: { kind: 'package', kody_id: '@owner/leaf' },
})

await kody.repoEditFiles({
	session_id: session.id,
	edits: [
		{
			kind: 'replace',
			path: 'src/index.ts',
			search: 'return { status: "todo" }',
			replacement: 'return { status: "done" }',
		},
	],
})

await kody.repoDiff({ session_id: session.id })

await kody.repoCommit({
	session_id: session.id,
	message: 'Mark triage complete',
})

await kody.repoRunChecks({ session_id: session.id })

await kody.repoPublishSession({ session_id: session.id })
```

Same-path `write`, `replace`, and `writeJson` edits in one `repoEditFiles` call
compose in order: each instruction sees the file as left by the previous one.
The last same-path edit's `content` is the file after the whole batch.

Each step returns structured JSON so agents can inspect diffs, check outcomes,
and publish results without shell parsing.
