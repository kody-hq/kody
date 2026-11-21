# Repo-backed source and Artifacts

[Data storage overview](./index.md)

## Repo-backed source and Artifacts

Repo-backed saved packages, package apps, and jobs use Cloudflare Artifacts
repos plus D1 `entity_sources` rows and a per-user `RepoSessionIndex` catalog.

- Primary code lives under `packages/worker/src/repo/`.
- `entity_sources` stores the durable mapping from
  `(user_id, entity_kind, entity_id)` to the repo identity and last published
  commit.
- `RepoSessionIndex` stores mutable editing-fork catalog rows for repo session
  Durable Objects. D1 does not hold catalog rows.
- Published source snapshots and bundle artifacts are stored in
  `BUNDLE_ARTIFACTS_KV` and keyed by `source_id` plus `published_commit`.

Canonical source contract:

- Published repo source is the only canonical source for saved packages, package
  apps, and jobs.
- D1 keeps metadata and projections only. It does not store canonical package
  export code, app backend code, or job code.
- App rows keep display metadata, parameters, visibility, `has_server_code`, and
  `source_id` for app projections.
- Job rows keep scheduling/execution metadata, params, storage id, caller
  context, repo check policy, `source_id`, and the published commit last synced
  into the job projection.
- Saved package rows keep display/search metadata, tags, app availability, and
  `source_id` for Kody search and package discovery.
- Projection updates are made from published repo state by the publish/reindex
  paths; stale D1 inline source fields are not a fallback.

Operational notes:

- Saved packages are the user-facing repo-backed identity. They resolve through
  D1 metadata to `entity_sources.id` when a repo editing session is opened.
- `source_id` is the internal durable join key for repo-backed packages, but
  most MCP callers should prefer package identity with `repoOpenSession` and the
  file-level session capabilities (`repoEditFiles`, etc.).
- Once repo-backed source exists, the repo snapshot is the durable source of
  truth for later edits and publishes. Search and detail payloads are derived
  projections of that repo-backed source rather than a competing second source
  of truth.
- Repo sessions expose a file-level API inside the RepoSession Durable Object:
  batch edits (`repoEditFiles`: write/replace/writeJson/delete/move; same-path
  content edits compose in order), unified diff apply (`repoApplyPatch`), git
  inspection (`repoStatus`, `repoDiff`, `repoLog`), commit (`repoCommit`), and
  restore (`repoRestore`). There is no git-command parser channel;
  branch/checkout/remote operations require the Artifacts git lane via
  `packageGetGitRemote`. Package runtime bundles are loaded from published
  artifacts rather than a mounted checkout. The session Workspace spills objects
  above the inline threshold to `REPO_SESSION_BLOBS` so clone and checkout can
  honor the 10 MiB per-file policy without hitting the Durable Object SQLite 2
  MiB row limit.
- `repoEditFiles` `write` edits use the same Durable Object `applyEdits` write
  path for whole-file overwrites. Prefer a `write` edit over `repoApplyPatch`
  when the agent is replacing an entire file (for example, a single-file job
  source) instead of patching a hunk with surrounding context.

### Direct Artifacts git publishes

Saved package source can also be edited through Artifacts git remotes directly.
`packageGetGitRemote` resolves package identity to `entity_sources`, mints a
short-lived Artifacts repo token, and returns a plain remote, `git_author`
(signed-in account email and display name), and setup commands that pass the
token through `http.extraHeader` and set local `user.email` / `user.name` from
`git_author`.

After an external `git push`, `packagePublishExternalPush` reconciles the
current Artifacts default-branch HEAD with `entity_sources.published_commit`.
The RepoSession Durable Object clones that commit, checks that it is a
fast-forward unless `allow_force` is set, runs `runRepoChecks(...)`, and then
calls `publishFromExternalRef(...)`.

`publishFromExternalRef(...)` owns the post-receive publish transaction:

- run manifest, docs (`README.md` + `AGENTS.md`), dependency, bundle, typecheck,
  and lint checks before mutation
- write the `PublishedSourceSnapshot` and manifest snapshot to
  `BUNDLE_ARTIFACTS_KV` for the new commit (key is commit-scoped; previous tip
  keeps serving until the pointer moves)
- advance `entity_sources.published_commit` only after that KV write succeeds
- delete the never-advertised new snapshot key if the D1 pointer update fails
- rebuild saved package projections, bundle artifacts, vector search entries,
  and package jobs through `refreshSavedPackageProjection(...)`

The same helper is used by the existing repo-session publish path after it has
pushed the session commit to the source Artifacts repo.

### Reconcile cron

`packages/worker/src/jobs/reconcile-artifacts-pushes.ts` is a safety net for
external pushes that were not followed by an explicit
`packagePublishExternalPush` call. In production, the `kody-jobs` cron trigger
(`packages/jobs-worker/wrangler.jsonc` `*/5 * * * *`) runs every five minutes
and sends each due maintenance lane to `kody-scheduled-dispatch`. Origin itself
has no cron trigger. The consumer is configured for one message per invocation
with independent concurrency, so a slow reconcile cannot consume the runtime
budget of retention, OAuth purge, or another sibling lane. Preview and local
runtimes execute the same registry inline when the production-only queue binding
is unavailable. A write-token mint sets the source's `external_check_until` to
the token expiry plus a one-hour grace period. The normal pass only scans these
pending sources, using `last_external_check_at` for the five-minute cadence and
keyset paging until the pending queue is drained or a wall-clock time budget
(`reconcileTimeBudgetMs`, ~60 seconds) is exhausted. Dormant package sources do
not incur an Artifacts HEAD lookup on every tick.

For each pending source, reconcile resolves the Artifacts default-branch HEAD.
When HEAD matches `published_commit`, it advances `last_external_check_at`
without any Durable Object work; once the token horizon has passed, that final
matching check also clears `external_check_until`. A successful explicit or
reconcile publish clears the pending horizon immediately. A durable publish that
fails because a newer push or publish won the race reopens the horizon, so the
next tick publishes the newest HEAD instead of waiting for the daily backstop.
That race fails the run without retries as a caller error, so it keeps its
`last_error` and stays off Sentry. Unresolvable or changed HEADs remain pending,
and the RepoSession publish path is spun up only when HEAD differs.

The reconcile loop is idempotent: if another caller publishes the same commit
first, the publish path returns `already_published`. Check failures and
non-fast-forward results leave D1/KV untouched and are counted in the one-line
metrics log, which also records batches processed and whether the time budget
was exhausted. Once per day during the 03:00 UTC cron window, reconcile also
widens the same keyset scan to every package source as a full-fleet backstop and
calls `revokeStaleArtifactsTokens(...)` for checked repos to clean up expired
Artifacts tokens.

Reconcile runs through the registry in
`packages/worker/src/scheduled/scheduled-lanes.ts`, alongside repo-session
cleanup, system-email retention, general retention, hourly usage-rollup
aggregation, hourly Durable Object duration attribution, and bounded USER
inbound Mailbox reconciliation (active-user discovery from the users/config
index followed by owner-point Mailbox due-work RPCs; no shared graph scan). Each
production queue message preserves `scheduled_lane_failed` / D1 lock-contention
log and Sentry context. D1 lock contention is replay-safe (the write did not
commit) and retries on `kody-scheduled-dispatch` with bounded backoff
(`max_retries` 3, then the dedicated DLQ plus a `scheduled_lane_retry_exhausted`
alert). Other handled lane failures are acknowledged as terminal so partial
external side effects are not replayed; the next eligible cron cadence is the
next automatic attempt. A failed enqueue is reported and runs through the inline
fallback after all sibling enqueue attempts finish; multiple failed enqueues
fall back sequentially to avoid D1 lock contention. Inline fallback is one-shot
and logs a non-completed outcome; it does not invent extra retries. Consumer
transport failures retain the configured retry/DLQ behavior. No failure can
abort or mask a sibling invocation.

`dlq_depth_alert` does not ride that queue: the cron calls it directly so a
stuck consumer cannot hide dead-letter backlog. Every five minutes it reads
Cloudflare queue metrics for each production dead-letter queue. A backlog that
has stayed non-empty for more than 15 minutes opens a Sentry issue (oldest
unacknowledged message, or the first non-zero sample when that timestamp is
missing). Operator Discord gets the issue from the existing Sentry alert
destination, the same path as the webhook auth regression alert. Non-production
runtimes skip the read. A failed metrics read fails the lane instead of
reporting the queue as empty. Inbound email subscription dead-letters are
terminal handler failures and are not part of this page.

The origin worker consumes every production DLQ and parks each message in APP_DB
`dead_letter_messages`; the alert counts those parked rows too, so a DLQ keeps
paging until an admin replays, acks, or purges its messages with the admin DLQ
capabilities ([dead-letter queues](../../dead-letter-queues.md)).

Production note:

- Production and preview Workers bind `ARTIFACTS` (wrangler `artifacts`,
  namespaces `production` / per-PR). `getArtifactsBinding()` uses that JSRPC
  binding when it matches `ARTIFACTS_NAMESPACE`, and falls back to the Artifacts
  REST client from `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and optional
  `CLOUDFLARE_API_BASE_URL` / `ARTIFACTS_NAMESPACE` when the binding is absent
  or the requested namespace differs (local/tests).
- During `npm run dev`, those REST calls go to the local Cloudflare mock Worker,
  which implements the Artifacts repo metadata endpoints used by the app
  (`create`, `get`, `list`, `createToken`, and `fork`). `cli.ts` also serves
  mock git remotes from `.wrangler/state/mock-artifacts-git`
  (`tools/mock-artifacts-git-server.ts`), so plain-repo `repoOpenSession`
  clone/push works locally. Saved-package repo sessions still use mock source
  snapshots — use a preview for that namespace. See
  [Local limitations](../../cloud-agents.md#local-limitations).
- Durable repo-source creation paths
  (`ensureEntitySource(..., requirePersistence: true)`) fail closed when
  persistence bindings are unavailable so callers do not write orphaned
  `source_id` references into D1.
