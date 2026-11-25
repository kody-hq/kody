# Production timing and D1 replica reads

Sample `Server-Timing` without changing production data. For local measurements,
see [Web app performance](../app-performance.md).

## Read Server-Timing

```bash
curl -s -o /dev/null -D - https://kody.codes/<path> | grep -i server-timing
npm run site-perf -- --url https://kody.codes/ --json
```

`ssr` is the time the Worker spent rendering. The
[D1 timing helper](../../../packages/worker/src/d1-round-trip-timing.ts)
reports:

| Field         | Meaning                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `d1`          | Summed wall time of instrumented D1 round trips, with the count in `desc`.                                                         |
| `d1-reported` | Wall time for calls with D1 metadata (`all`, `run`, `batch`; not `first`).                                                         |
| `d1-sql`      | Reported SQL time for those calls. When available, serving locations and roles appear in `desc` (for example, `WNAM-SJC-primary`). |

Subtract `d1-sql` from `d1-reported` for time outside the reported SQL: travel,
queueing, and any attempts D1 retried. D1 reports SQL time for the last attempt
only. Compare several samples rather than relying on the cold first request
after a deploy. [Weekly site performance](../weekly-site-perf.md) tracks landing
page budgets; [`/health`](../control-kody.md) shows which commit is live.

## Write paths and replica reads

When the `d1-replica-reads` rollout selects a browser request, the
[document route policy](../../../packages/worker/start/server/route-method-policy.ts)
and [server function entry point](../../../packages/worker/start/http-entry.ts)
opt plain pages and server functions into replica reads. The
[`APP_DB` wrapper](../../../packages/worker/src/d1-replica-reads.ts) restricts
that opt-in to GET and HEAD. The
[replica routing tests](../../../packages/worker/src/d1-replica-reads.node.test.ts)
verify that non-opted-in GETs and POST, PUT, PATCH, and DELETE use the primary
even while a page can still see stale membership.

- **Use POST for writes.** Until the render returns its response, a failed
  replica read or a write attempted after a replica read causes a rerender on
  the primary; later work, such as header preparation, is not retried. The
  [retry tests](../../../packages/worker/src/d1-replica-reads.node.test.ts)
  verify that the Worker logs the reason, adds `d1-primary-retry` to
  `Server-Timing`, and does not execute the attempted write on the first run.
- **Send independent telemetry to the primary.** Use
  [`runOnD1Primary`](../../../packages/worker/src/d1-replica-reads.ts) for a
  write that neither the response nor a permission check depends on.
- **Expect lag across browsers.** An eligible read carrying its own write's
  `kody_d1` cookie (60-second lifetime) starts with the primary's bookmark. The
  [same-browser test](../../../packages/worker/src/d1-replica-reads.node.test.ts)
  verifies that the bookmarked read sees the write while an unbookmarked read
  can lag until replication catches up.
