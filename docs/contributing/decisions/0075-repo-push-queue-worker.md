# 0075: Repo pushes serialize through a per-repo Durable Object in a dedicated worker

- **Status:** accepted
- **Date:** 2026-10-14

## Context

Cloudflare Artifacts serializes `git-receive-pack` per repository and rejects a
concurrent push with `artifacts_git_receive_pack_busy`. In production that
arrives in-band as HTTP 200 with a sideband fatal (band 3) pkt-line, not as an
HTTP error. The isolate-local wait and retry in origin's smart-HTTP proxy
(#3797) only orders pushes that land on the same isolate, and multi-agent push
storms land on many isolates and colos. Origin owns no Durable Objects
([0034](./0034-origin-owns-no-durable-objects.md)).

## Decision

A dedicated `kody-push-queue` worker owns `RepoPushQueueV1`, one Durable Object
per repo (`idFromName(sourceId)`). Origin hands flagged pushes over the
`REPO_PUSH_QUEUE` service binding to the non-public `RepoPushQueueGateway`
entrypoint, sending the Artifacts upstream URL and bearer token per request.

The queue lands the whole pack in Durable Object storage (1 MiB chunks) before
the push joins the FIFO, so an accepted push survives the caller going away and
a handoff that dies mid-upload is never enqueued. Pushes reach Artifacts one at
a time; busy (HTTP error or in-band) is retried inside the turn. Each push has a
90s budget from arrival, then gets 503 with `Retry-After: 2`. Report-status
passes through unchanged, so refs stay atomic and non-fast-forward rejections
are git's own. Chunks are deleted after every push. The token is held in memory
only and never stored, so a replaced instance clears leftover chunks and its
callers retry.

There is no fallback to the direct path when the queue is unavailable: that
would reintroduce the cross-isolate race the queue exists to remove. Routing is
the repo-scoped `repo-push-queue` flag (per-repo allowlist in
`feature_flag_repo_overrides`, percentage rollout bucketed by source id,
experiments audience on the owner); unflagged repos keep #3797's path.

## Consequences

A deploy of the push queue worker resets in-flight queues once: an in-flight
push whose pack fits in memory (8 MiB) finishes, and queued callers get a
retryable 503. Class names are versioned; a breaking storage or protocol change
adds `RepoPushQueueV2` in a new migration tag. The first deploy of a class (or
any migration) must use `wrangler deploy`; later code-only changes can use
gradual `wrangler versions` deployments, and each Durable Object stays on one
version while it runs. Origin, platform, and runtime deploys do not touch the
queue.

**Amended (stale fetch-first, 2026-11-13):** Before each Artifacts send, the
queue checks command old-oids against the tip it last landed and that tip's
immediate predecessor. When the client requested report-status and every
command's old-oid is that predecessor it answers report-status
`ng <ref> fetch first` and skips the Artifacts exchange. Clients that did not
request report-status still send. Other report-status still passes through
unchanged.

**Revisit-if:** Artifacts offers a native per-repo push queue or a lock-wait
option, or pushes need to resume across a queue instance reset (which would need
stored credentials).
