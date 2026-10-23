# 0011: Workers-unit keeps per-file isolation; budget cold DO load in timeouts

- **Status:** accepted
- **Date:** 2026-08-07

## Context

`@cloudflare/vitest-pool-workers` charges roughly 10–18s to load Durable Object
classes (Mailbox, UserMeter, RunLog) through the Vitest module runner. Warm RPCs
are ~1ms; production is ~0.4ms. That cold load sat inside `testTimeout`, so a 5s
local default failed pre-push while `CI=1` (20s) stayed green and agents reached
for `--no-verify`.

Alternatives considered:

- Warm in `globalSetup` — runs in Node; cannot touch workerd bindings.
- Warm in workers-unit `setupFiles` via `runInDurableObject` or stub RPCs —
  moves cost out of test bodies, but breaks webhook routing, scheduled-lane,
  subscription-dispatch, and `packageSave` workers suites (measured: 9 failures
  that pass when the warmup is removed).
- `--maxWorkers=1 --no-isolate` to pay once for the whole run — much faster wall
  clock, but shared D1/KV/DO storage breaks suites that assume per-file
  isolation (~50 failures on a full workers-unit run).
- Stubbing DOs in node tests when the point is binding fidelity — drops the
  thing under test.

## Decision

Keep per-file storage isolation and parallel workers-unit. Do **not** warm
Durable Objects from `globalSetup` or workers-unit `setupFiles`. Prefer
`*.node.test.ts` unless real Cloudflare bindings or Workers-only APIs are
required. Keep a shared Vitest `testTimeout` of 20s (and `CI=1` on `test:push` /
validate’s test and e2e legs) so the pool’s per-file DO cold load does not fail
the default budget. When `npm run validate` runs workers-unit beside the rest of
the parallel gate (`KODY_VALIDATE_LOAD=1` on that leg only; #2939 / #2475),
`vitest.workers.config.ts` caps `maxWorkers` at 2 rather than the dedicated CI
Workers job's 4; both caps respect available CPU affinity. Workers-unit's
`testTimeout`/`hookTimeout` is 40s everywhere (not only under the flag) so the
budget a cached `test-workers` result passed under is the one CI enforces. On
machines with at most 4 cores or under 24GB RAM, `tools/run-validate.ts` also
runs suite legs one at a time so they do not exhaust the VM (#3147). The load
flag stays for larger machines, where those legs still share the box. The
override stays on the workers project only (not `sharedProjectConfig`) so
node-unit Nx caches stay keyed to the 20s default; do **not** loosen production
worker startup CPU budgets for that contention (`worker-startup-time:check`
already runs after validate's parallel phase).

## Consequences

- First DO RPC in a workers-unit file can still take ~10s; suites that need more
  headroom keep an explicit per-test timeout.
- Agents must not “fix” pool slowness with `--no-isolate`, `setupFiles` /
  `globalSetup` DO warmups, `--no-verify`, or a shorter local `testTimeout`.
- Misclassified `*.workers.test.ts` files that never need bindings or
  Workers-only APIs should become `*.node.test.ts`.
- Revisit if Cloudflare’s pool loads DO classes cheaply (for example Vite
  bundled-dev), or if a warmup approach is proven not to disturb export wrapping
  / storage isolation.
