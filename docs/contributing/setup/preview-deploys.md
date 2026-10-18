# PR preview deployments

The GitHub Actions preview workflow creates per-preview Cloudflare resources so
each PR preview is isolated. See the [setup index](./index.md) for the other
setup pages.

- App worker: `<preview-worker-name>` (for kody: `kody-pr-<n>`). Generated
  preview config sets `workers_dev: true` so secret-bulk reapply cannot drop the
  `<name>.<subdomain>.workers.dev` trigger (Cloudflare error 1042).
- Platform worker: `<preview-worker-name>-platform`
- Runtime worker: `<preview-worker-name>-runtime`
- Jobs worker: `<preview-worker-name>-jobs`
- Highlight worker: `<preview-worker-name>-highlight`
- App D1 database: `<preview-worker-name>-db`
- Audit D1 database: `<preview-worker-name>-audit-db`
- Jobs D1 database: `<preview-worker-name>-jobs-db` (passed to
  `jobs-worker-resources.ts --jobs-d1-name`, so a migration rehearsal on one
  preview cannot corrupt another preview's jobs tables)
- Vectorize index (`CAPABILITY_VECTOR_INDEX`): `<preview-worker-name>-vectors`
  (384-dimension cosine with the `kind`, `userId`, `status`, `category`, and
  `domain` metadata indexes). After the origin is healthy, the workflow runs
  `tools/ci/reindex-capabilities.ts --phases capabilities --force` with a
  per-deploy random `CAPABILITY_REINDEX_SECRET` so builtin capability search
  works on the fresh index (`--force` because APP_DB embed fingerprints can
  outlive the index they described). A per-preview index (instead of a namespace
  prefix inside a shared index) avoids sharing production's index namespace and
  lets cleanup delete every preview vector in one call; Cloudflare allows 50,000
  indexes per account.
- KV namespace (OAuth state): `<preview-worker-name>-oauth-kv`
- KV namespace (published source snapshots / bundles):
  `<preview-worker-name>-bundle-artifacts-kv`
- Cloudflare Artifacts namespace: `<preview-worker-name>` (same as the app
  worker name, for example `kody-pr-<n>`). Package create/publish/overwrite and
  git remotes use this namespace via the `ARTIFACTS` binding and
  `ARTIFACTS_NAMESPACE` var — not the shared committed `preview` namespace.
- Mock workers: `<preview-worker-name>-mock-<service>`
- Queues: one queue and dead-letter queue per origin producer binding, named
  `<preview-worker-name>-<production-suffix>` (for example
  `kody-pr-<n>-platform-feedback-dispatch`). The list is the production origin
  producer set in `packages/worker/wrangler.jsonc`, except
  `PACKAGE_EVENTS_DISPATCH_QUEUE`, which preview still delivers inline.
  `tools/ci/preview-queue-plan.ts` is that rule. Adding a production producer
  without an inline fallback provisions it on the next preview.

When a PR is closed, the cleanup job deletes the preview
app/platform/runtime/jobs Workers, mock Workers, Queues, per-preview app, audit,
and jobs D1, KV, R2, the Vectorize index, the per-PR Artifacts namespace (repos
emptied, then namespace deleted when the API allows), and these per-PR
resources. It does not delete the committed `kody-preview*` placeholder names,
the shared Artifacts namespaces `production` / `preview`, or any production
name.

Leftover preview Workers keep their Durable Object namespaces, and the account
allows 500. When that cap is hit, every preview deploy fails (Cloudflare code
10067). Two more paths keep previews from piling up:

- A failed PR preview deploy runs the same cleanup before the job ends. The next
  push re-creates the preview from scratch. Branch previews keep their state
  after a failed deploy so a
  [migration rehearsal](../preview-migration-rehearsal.md) can inspect it.
- `.github/workflows/preview-sweep.yml` runs hourly (and on `workflow_dispatch`,
  with `max` and `dry_run` inputs). It lists the account's Worker scripts,
  Durable Object namespaces, D1 databases, KV namespaces, and R2 buckets, picks
  out `kody-pr-<n>` previews whose PR is closed, and runs the same cleanup for
  up to 10 of them per run, oldest first (`tools/ci/preview-sweep.ts`). It
  re-checks the PR state just before each cleanup and skips previews with no
  matching PR. It also sweeps `kody-branch-*` previews whose bare Worker script
  is gone, judging liveness only from the Worker scripts listing (re-fetched
  again right before cleanup) so a same-named D1/KV/R2 resource from another
  branch can never read as "live". Branch sweeping is skipped for the whole run
  if a `workflow_dispatch` `preview.yml` deploy is currently queued or in
  progress, since a deploy provisions D1/KV/R2 before it uploads the bare origin
  Worker. PR-push preview runs don't defer it. A live branch preview is also
  swept once every PR for the branch it was last deployed from is closed, and
  the last close came after that deploy. The sweep finds that branch from the
  `Preview deploy (branch: <name>)` run name `preview.yml` sets on dispatch.
  Previews deployed from `main`, from a branch with no PR, or before that run
  name existed are kept, as is any preview whose newest deploy is still running
  or whose recent runs came from different branches. Live branch previews whose
  last recorded deploy is older than 7 days are also swept (TTL for rehearsal
  leftovers that never close a PR). Each delete re-checks the PRs first. Both
  the PR and branch loops share one wall-clock budget per run, so a run that
  spends it on PR cleanups still defers branch cleanups cleanly instead of
  running past the job timeout. Preview ensure also asserts Durable Object
  namespace headroom before provisioning so the job fails with a clear quota
  message near the 500-namespace cap instead of mid-deploy 10067/10090.

Cleanup is bounded, retry-safe, and idempotent. Transient Cloudflare 429 and 5xx
responses (including wrangler 504 Gateway Timeout) retry with backoff inside the
four-minute job budget. Permanent 401/403 failures are not retried. A failure on
one resource does not skip later independent resources: the sweep finishes, then
fails once with every leftover name. Already-missing resources count as success.
Queue consumers are removed before Workers, and Workers before Queues, because
those deletes depend on each other. Non-empty preview R2 buckets are emptied
(objects deleted) before the bucket delete; leftover objects surface in the same
aggregate failure instead of a warning.

Cloudflare Workers supports version `preview_urls`, but those preview URLs are
not available for Workers that use Durable Objects. The main app Worker binds
`MCP_OBJECT`, so app previews use per-PR Worker names. Mock Workers do not use
Durable Objects, so their Wrangler configs opt into `preview_urls = true` and
the workflow includes mock version preview links when Cloudflare returns them.

Production deploys also ensure required Cloudflare resources exist before
migrations/deploy:

- D1 database: from `env.production.d1_databases` binding `APP_DB`
- KV namespace: `OAUTH_KV` (defaults to `<worker-name>-oauth` when creating)

Both the preview and production deploy workflows run post-deploy healthchecks
and fail the job if any expected worker is missing the deployed commit:

- origin: `<deploy-url>/health` →
  `{ ok: true, commitSha, commit, pullRequest, deploy }` (`commitSha` is the
  version pin; browsers that prefer HTML get clickable commit/PR/job links)
- platform: `/__platform/health` → `{ status: "ok", commitSha }`
- runtime: `/__runtime/health` → `{ status: "ok", commitSha }`
- jobs: `/health` on the jobs workers.dev URL → `{ ok: true, commit }` (jobs has
  no public hostname; the workflow uses the deploy output URL)

Preview deploys also run `node tools/seed-test-data.ts --remote` after deploy,
seeding `me@kentcdodds.com` / `ilikecode` (a non-admin account; the `jane`
companion account is only seeded locally). A `preview-flag:<key>` label on the
PR adds `--enable-flag <key>` for keys on
`tools/preview-seed-flag-allowlist.ts`. See `.github/workflows/preview.yml` for
the exact invocation and
[Manual preview testing](../preview-manual-testing.md#feature-flags-on-the-preview-seed).

Preview deploys do **not** set a GitHub Actions `environment:` on the deploy
job. The preview URL is posted as a PR comment instead.

Cleanup deletes any leftover `preview-<pr-number>` GitHub Environment on PR
close. That API requires repository administration write access, so the repo
must define a `PREVIEW_ENVIRONMENT_ADMIN_TOKEN` Actions secret with a token that
has that permission. When that secret is missing or under-scoped, the
environment-delete step emits a warning annotation instead of failing the job,
so a permission regression does not paint closed PRs red. The Cloudflare
resource and GitHub deployment cleanup steps still fail on errors.

Every Cloudflare delete in `tools/ci/preview-resources.ts` (Workers, D1, KV, R2,
Queues and their consumers, Vectorize indexes, Artifacts namespaces) first
passes through `assertPreviewResourceName(name, kind)`, which throws unless the
name matches `^kody-(pr-<number>|branch-<slug>)(-<segment>)*$`. Production names
(`kody`, `kody-platform`, `kody-audit`, `kody-webhook-dispatch`, ...), shared
Artifacts namespaces (`production`, `preview`), and the shared `kody-preview*`
names never match, so a bug or an empty PR number cannot compute a production
name and delete it. `npm run deploy-guardrails:check` fails if a destructive
call in that script is not preceded by the guard in the same function.

The production deploy workflow can also be started manually from GitHub Actions
via **Run workflow** on `main`. The manual path verifies that the selected
commit is the current `origin/main` HEAD before it deploys, and force-deploys
every worker (including optional ones the 15-commit path-filter lookback can
skip after a long Validate gap). See [rollback](../rollback.md).

If you ever need to do the same operations manually, use:

- `node tools/ci/preview-resources.ts ensure --worker-name <name> --out-config <path>`
- `node tools/ci/preview-resources.ts cleanup --worker-name <name>`
- `node tools/ci/preview-resources.ts reset-d1 --worker-name <name>` (per-PR
  app, audit, and jobs D1; see migration renumber race below)
- `node tools/ci/production-resources.ts ensure --out-config <path>`

### Migration renumber race on an existing preview D1

When a long-lived PR preview already applied migration `NNNN-foo.sql`, then
`main` lands another `NNNN-…` and the branch renumbers to `NNNN+1-foo.sql`,
Wrangler would otherwise re-apply the same SQL under the new name and fail (for
example `duplicate column name`). Before each preview `d1 migrations apply`, the
workflow runs `tools/ci/rewrite-renamed-preview-migrations.ts` (requires
`CLOUDFLARE_ENV=preview`). It rewrites `d1_migrations` rows whose filename is
gone but whose SQL sha256 still matches a current file on the branch (historical
SQL is recovered from git with `rev-list --full-history` then `commit^:path`
when the last touch renamed the file — `--full-history` is required on GitHub PR
merge refs — and multi-hop renumbers still match by content sha; the preview
deploy job checks out with `fetch-depth: 0`). It does **not** guess from the
kebab slug alone — that would skip applying revised SQL after a rebase that also
changed the migration. The script also refuses any wrangler config whose binding
`database_name` is not a preview name (`kody-pr-*` / `kody-branch-*`). That is
bookkeeping only — not a schema drop — and never runs in production.

If rewrite cannot match (content changed as well as the name, or git cannot
recover the old file), use the **reset preview D1** fallback for **PR** preview
databases only (`kody-pr-<n>-db`, `kody-pr-<n>-audit-db`, and
`kody-pr-<n>-jobs-db`). This deletes preview seed data for that PR; the next
Deploy Preview Resources run recreates the D1s, applies migrations fresh, and
reseeds. It is not a production data-drop. Names still pass through
`assertPreviewResourceName`, and `reset-d1` refuses `kody-branch-*` worker
names.

```bash
# Requires CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID for list/delete).
# Worker name must be exactly kody-pr-<n>.
node tools/ci/preview-resources.ts reset-d1 --worker-name kody-pr-<n>
```

Then re-run the preview workflow (or `preview-resources.ts ensure` followed by
migrations apply and `tools/seed-test-data.ts --remote`).

To **manually test** a PR preview (find the URL, sign in as the seeded user,
create specific data with `--request`, assert the change), see
[Manual preview testing](../preview-manual-testing.md) and run
`npm run preview:manual-test`.
