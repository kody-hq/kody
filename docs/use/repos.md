# Plain repos

Plain repos are Kody's base Artifacts-backed storage primitive. Every plain repo
maps to a Cloudflare Artifacts git repository via `entity_sources` with
`entity_kind = 'repo'`. They are **live-at-HEAD**: pushes and session publishes
materialize directly on the default branch with no `published_commit` publish
step and no external-push reconcile lane.

Saved packages are an **explicit extension**: a package is a repo whose
`entity_sources` row has `entity_kind = 'package'` and a matching
`saved_packages` projection. Activation is never inferred from contents—a root
`package.json` alone does not make a package. Use `repoPromoteToPackage` when
you want runtime surfaces (exports, apps, jobs, webhooks).

## Capabilities

| Capability                       | Purpose                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoCreate`                     | Create a `user_repos` row and backing Artifacts repo (enforces `repos` entitlement).                                                                                                                      |
| `repoList`                       | List plain repos from D1 (`user_repos`); no live Artifacts reads.                                                                                                                                         |
| `repoGet`                        | One repo by id or name, live default-branch HEAD, `package_shaped` hint.                                                                                                                                  |
| `repoDelete`                     | Delete `user_repos`, `entity_sources`, and Artifacts repo (best-effort).                                                                                                                                  |
| `repoGetGitRemote`               | Short-lived git remote (defaults to write when you can write, else read). Write pushes are live at HEAD (no publish reconcile).                                                                           |
| `repoPromoteToPackage`           | Full publish checks + saved-package projection when root `package.json` exists at HEAD.                                                                                                                   |
| `repoOpenSession` + session lane | File-level editing (`repoEditFiles`, `repoApplyPatch`, `repoCommit`, `repoStatus`, `repoDiff`, `repoLog`, `repoRestore`, `repoRunChecks`, `repoPublishSession`, …) with `target: { kind: "repo", name }`. |

`repoList` includes `icon_url` when the repo has an indexed (or published)
commit. Put the list mark at `.kody/icon.png` (also `.svg`, `.webp`, `.jpg`,
`.jpeg`). Root `icon.*` and `community-icon.*` are aliases. See
[Package icon](../guides/package-authoring.md#package-icon) for the resolution
order. A default-branch push indexes the mark from the new HEAD. Website list
and detail marks use `/@:owner/:name/icon/:iconCommit` (same shape as packages;
the route falls back to `entity_kind:'repo'` with public/member access). The
owner-session MCP lane remains `/account/repos/:repoId/icon/:iconCommit`. Repos
without a file show a monogram from the repo leaf name.

Plain repos do not have Vectorize/search integration—use `repoList` for
discovery.

## Git lane

`repoGetGitRemote` mints a short-lived git remote that points at Kody's
smart-HTTP proxy (`/git/sources/{source_id}.git`), which forwards to Cloudflare
Artifacts with the minted bearer token. When `scope` is omitted, it defaults to
**write** if you have org-wide write access, otherwise **read**. Explicit
`scope` is honored; requesting write without write access is denied with
guidance. A read remote rejects push with:
`this remote is read-only; request scope: 'write'`. Pass exactly one of
`repo_id` or `name`. Open API / CLI: prefer `POST /v1/repos/git-remote` with a
JSON body (`name` or `repo_id`) so clients do not need a path id. The alias
`POST /v1/repos/{repo_id}/git-remote` accepts a UUID or the repo name in that
segment. Concurrent push lock contention from Artifacts
(`artifacts_git_receive_pack_busy`, sent either as an HTTP error or in-band as
an HTTP 200 sideband fatal) is held and retried on the proxy (45s bounded wait,
same-isolate FIFO) before returning HTTP **503** with `Retry-After` and the body
`repository busy, retry`, so git clients usually wait out the lock instead of
hanging up or stampeding retries. Repos with the `repo-push-queue` flag go
through a per-repo Durable Object queue instead: pushes from every client are
served one at a time in arrival order, each with a **90s** budget, and anything
past the budget (or a full or unavailable queue) gets **503** with
`Retry-After: 2`. Queued push responses carry `Kody-Push-Queue: v1`,
`Kody-Push-Queue-Position` (pushes ahead on arrival), `Kody-Push-Queue-Wait-Ms`,
`Kody-Push-Queue-Attempts` (Artifacts sends, so `>1` means busy was retried),
`Kody-Push-Queue-Depth` (pushes already in the queue on arrival),
`Kody-Push-Queue-Wall-Ms` (time the push spent in the queue, including its
send), and on 503 `Kody-Push-Queue-Outcome` (`timeout`, `full`, or
`unavailable`). Unflagged pushes report `Kody-Push-Queue: off`. Real ref
contention (non-fast-forward, stale ref) still comes back as git's normal
rejection. The result includes `git_author` (signed-in Kody account email and
display name) and setup commands that set local `user.email` / `user.name` to
that identity. Use those values for commits; do not invent a git email. Kody's
**10 MiB** per-file gate (10,485,760 stored bytes) binds on session and
file-level writes and again at `repoPromoteToPackage`; the proxied push lane
does not re-apply that gate. Push size is bounded by Artifacts, which rejects
pushes above ~32 MiB of decompressed pack content with a raw HTTP 413, and by
Kody, which holds each receive-pack request body (in proxy memory, or in queue
storage for flagged repos) so busy retries can resend it, and rejects bodies
above **40 MiB** with HTTP 413. Plain repos do not run the package publish
reconcile cron after push—HEAD is live.

## Sessions

Open with `repoOpenSession` using `target: { kind: "repo", name: "<name>" }` or
`source_id`. Session base is the current default-branch HEAD (not a publish
pointer). Pass `conversation_id` to resume that conversation's active session.
Omitting `conversation_id` always mints a new session: never-checkpointed is not
the same as abandoned, and two callers of the same source must not share a
workspace that has not checkpointed yet. `repoPublishSession` on a plain repo
runs only the source size walk (manifest, bundle, typecheck, and lint checks are
skipped). When the published tree contains root `package.json`, the result
includes `package_shaped: true` and a promote notice.

## Promote flow

When a plain repo has `package.json` at HEAD, `repoGet` and publish surfaces
surface progressive disclosure (`package_shaped`, `activated: false`, promote
notice). `repoPromoteToPackage` enforces the `saved_packages` entitlement, runs
full publish checks, creates the `saved_packages` row, flips `entity_sources` to
`package` while seeding `published_commit` from the session's HEAD (plain repos
have no publish pointer, and a null pointer after the flip looks like a stale
session), and deletes the `user_repos` row.

## Mental model

Repos are the durable home for versioned source; packages add runtime surfaces
on top of an explicitly activated extension.

## Package subscriptions for repo lifecycle

Kody relays Cloudflare Artifacts repository lifecycle events into package
subscriptions for the owning user:

| Topic          | Cloudflare event            | When it fires                            |
| -------------- | --------------------------- | ---------------------------------------- |
| `repo.pushed`  | `cf.artifacts.repo.pushed`  | Commits land on a managed Artifacts repo |
| `repo.created` | `cf.artifacts.repo.created` | A managed Artifacts repo is created      |
| `repo.deleted` | `cf.artifacts.repo.deleted` | A managed Artifacts repo is deleted      |

Account-level Artifacts subscriptions deliver `repo.pushed` as
`cf.artifacts.repo.pushed` with `source.type === "artifacts"`. Repo-scoped
wrappers use the same event type with `source.type === "artifacts.repo"`.

Declare handlers under `package.json#kody.subscriptions`. Delivery is same-user
only: packages saved by the entity owner that declare the topic receive the
event. Session fork Artifacts repos, session workspace branch pushes
(`sessions/<id>`), published-only codemod tips (`kody-published`), and publish
git-notes (`refs/notes/commits`) never fan out.

`repo.pushed` is the primary automation hook (for example resyncing a projection
after a git-lane push to a plain repo). For packages, a push updates HEAD but
does **not** by itself advance `published_commit` — publish /
`packagePublishExternalPush` / reconcile still own activation.

Payload shapes and idempotency details live in the
[package subscriptions guide](../guides/package-subscriptions.md).
