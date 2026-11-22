# kody Nx remote cache

Self-hosted Nx HTTP remote cache for this repository. Agents and GitHub Actions
share task artifacts so CI does not rerun work the agent already completed.

The worker implements the
[Nx self-hosted cache OpenAPI spec](https://nx.dev/docs/kb/self-hosted-caching):
`GET`/`PUT /v1/cache/{hash}` with bearer auth, `409` on overwrite, `403` when a
read-only token PUTs, and artifacts stored in R2. `neverConnectToCloud` stays on
so Nx does not prompt for Nx Cloud. Same-repo validate and Cloud Agent
environments use the write token. Fork `pull_request` jobs use the read token.

Public URL: `https://nx-cache.kody.codes`.

## Clients

Nx always reads `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`. The value is the
write token on trusted writers (Cloud Agent environments and same-repo validate)
and the read token on fork `pull_request` validate
(`NX_SELF_HOSTED_REMOTE_CACHE_READ_TOKEN`).

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache.kody.codes
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="<write-or-read-token>"
```

Leave them unset to run with the local `.nx` cache only. Validate and
`test:push` use `CI=1` so test cache hashes match GitHub Actions (`CI=true`
would miss); typecheck and build hashes ignore `CI`, so `npm run typecheck`
matches CI with or without it. On Cloud Agent VMs, `npm run hooks:ensure`
composes Husky through Cursor's hook dispatcher so `git push` runs `test:push`
when the push includes a non-docs path, and can upload those artifacts before CI
starts. Docs-only pushes skip `test:push`. `tools/nx-remote-cache-probe.ts` is
the one place that checks the server: GitHub Actions only sets the server URL
after `GET /health` succeeds and an authorized `GET /v1/cache/{hash}` returns
200 or 404 — Nx fails the job if the host is configured but unreachable or
unauthorized, so validate can still pass before the worker exists or after a
token rotation that has not been synced yet. The same probe then `PUT`s a fixed
non-hash key (`00000000000000000000000000000001`): 200 or 409 means the token
writes, 403 means it is read-only. Nx prints nothing when a `PUT` is rejected,
so every cached script ends with one line next to Nx's own hit count, for
example
`Nx remote cache enabled (https://nx-cache.kody.codes) READ-ONLY: PUT returned 403 ... Cache: 0/12 hit (0%)`.
A read-only or failed write never fails the run; it is the signal that the token
or the worker secret needs fixing before any hit can happen. Cached npm scripts
(`test:node`, `test:workers`, `test:e2e:run`, `test:mcp`, `test`, and
`typecheck`) run through `tools/run-nx.ts`. Before Nx starts, that wrapper
probes the cache the same way CI does and unsets
`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` when the token cannot read, so a stale or
rotated token degrades to the local cache with a warning. A transport error
talking to `/v1/cache/{hash}`, or Nx's `Misconfigured remote cache endpoint` /
`Unauthorized` cache error, after Nx already printed `Successfully ran target`,
a `✔ nx run` success mark, or Playwright's all-pass summary for `:test-e2e`
(passed, with no failed, interrupted, did-not-run, or run-level error lines), is
treated as success even when Nx then lists that task under `Failed tasks`. The
same failure before tasks finish retries once with `--skipRemoteCache` and
without `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`.

`npm run nx-cache:smoke` (also part of `test:node`) starts a local HTTP cache,
runs `nx-cache:smoke-probe` twice with an isolated local cache wiped in between,
and asserts the second run is a `[remote cache]` hit that restores outputs
without re-running the command.

## Interpreting hit rates

A PR that **introduces or renames Nx tasks** (or expands their `inputs`) makes
those tasks' hashes cold. Nx checks each task hash independently, so unaffected
tasks can still hit. You only see `Cache: 0/N` when every counted task misses
(for example a first run where all N hashes are new). Same-repo validate uses
the write token (decision 0040), so that first run **PUTs**; the next identical
tree on `main` or another PR should show `[remote cache]` hits. Example after
parallel typecheck (#3209): the PR logged `0/12`, and the following `main`
validate logged `12/12`.

Do **not** treat a cold `0/N` alone as a token, Nx Cloud, or `--skip-nx-cache`
bug. Check the setup step for
`Nx remote cache enabled (https://nx-cache.kody.codes)` first. Fork PRs use the
read token only and cannot populate new hashes. Suite targets that hash
`{workspaceRoot}/**/*` (notably `test-node` after #3207) miss whenever any
non-gitignored workspace file matched by the input changes — that is intentional
correctness, not a transport failure. Nx leaves `.gitignore`d paths out of
fileset inputs unless a fileset sets `includeIgnored: true`.

## Retention

R2 expires `v1/` objects 14 days after they are written and aborts incomplete
multipart uploads after 1 day. Production deploy reapplies that lifecycle when
it ensures the bucket. First PUT wins (`409` on overwrite), so expiry is also
the window after which a poisoned hash can be replaced.

## Deploy

Production deploy (`.github/workflows/deploy.yml`) creates the `kody-nx-cache`
R2 bucket, applies the 14-day lifecycle, uploads the worker, and syncs
`CACHE_ACCESS_TOKEN` / `CACHE_READ_TOKEN` from the matching GitHub Actions
secrets when cache-related paths change or when that workflow is dispatched on
`main`. The job no-ops when the write secret is missing so a first merge does
not block production.

To redeploy only the cache worker (for example after rotating either token), run
**Actions → 🧊 Nx cache worker → Run workflow** on `main`
(`.github/workflows/nx-cache-deploy.yml`). That reuses the same job and does not
cancel an in-progress production deploy.
