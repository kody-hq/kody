# kody push queue worker

Owns `RepoPushQueueV1`, the per-repo write queue for Cloudflare Artifacts
`git-receive-pack`. Origin owns no Durable Objects (ADR 0034), so origin's smart
HTTP proxy hands flagged pushes to this script over the `REPO_PUSH_QUEUE`
service binding (named `RepoPushQueueGateway` entrypoint, never public). The
only public route is `GET /health` on the workers.dev URL the deploy workflow
records.

One Durable Object per repo (`idFromName(sourceId)`) serializes every push for
that repo across all origin isolates and colos:

1. The whole pack lands in Durable Object storage (1 MiB chunks) before the push
   joins the queue. A handoff that dies mid-upload is never enqueued; the git
   client retries.
2. Pushes reach Artifacts one at a time, FIFO. Artifacts busy (HTTP error body
   or in-band HTTP 200 sideband fatal) is retried inside the turn.
3. Every push shares a 90s budget from arrival. Past it, or when the queue or
   storage is unavailable, the client gets `503` with `Retry-After: 2`.
4. Before each Artifacts send, the queue compares command old-oids to tips it
   last landed (`ok <ref>` + that command's new-oid). When every command is
   already known-stale it answers with report-status `ng <ref> fetch first` and
   skips the Artifacts exchange (N agents racing one ref stay O(N), not O(N²)).
   Cache misses and mixed stale/fresh multi-ref pushes still send. Other
   report-status (non-fast-forward, etc.) passes through unchanged. Chunks are
   deleted after every push.

The Artifacts token stays in memory only and is only sent to HTTPS
`*.artifacts.cloudflare.net` receive-pack URLs (`ARTIFACTS_UPSTREAM_HOST_SUFFIX`
overrides the host). A stalled Artifacts exchange is aborted 120s past the
push's deadline so the queue keeps moving. A replaced instance (deploy or
eviction) clears leftover chunks on start, and those callers retry.

- `wrangler.jsonc` — committed config (script name `kody-push-queue`). Class
  names are versioned: a breaking change adds `RepoPushQueueV2` in a new
  migration tag instead of editing V1.
- Build check: `npm run push-queue:build` (part of `npm run validate`).
- Deploys/previews: `.github/workflows/deploy.yml` (before origin, so the
  service binding resolves) and `preview.yml`.
- Routing is gated by the repo-scoped `repo-push-queue` flag; see
  [docs/use/repos.md](../../docs/use/repos.md).
