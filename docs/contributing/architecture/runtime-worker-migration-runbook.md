# Runtime worker migration runbook

Production owns the package-runtime Durable Object classes and package-app zone
routes on `kody-runtime`. `transferred_classes` is a one-shot cutover; do not
invent a second transfer or add `deleted_classes` for those names.

This page records current ownership and the invariants later deploys must keep.

How the package runtime lane lives on the `kody-runtime` Worker
(`packages/runtime-worker/`), per
[ADR 0016](../decisions/0016-mono-worker-extraction.md). Later deploys follow
`.github/workflows/deploy.yml`. UI/blog-only uploads skip runtime.

## Ownership

| Concern                                                             | Owner                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Package-app origin (`PACKAGE_APP_BASE_URL`, `kody.run`) zone routes | `kody-runtime`                                                              |
| Inline package-app serving (`/apps/...` on the app origin)          | `kody-runtime` (forwarded by main via the `RUNTIME_WORKER` service binding) |
| Package invocation API                                              | `kody-runtime` (forwarded by main)                                          |
| `DynamicCallableWorkflow` (Cloudflare Workflow)                     | `kody-runtime` (main binds it cross-script)                                 |
| `StorageRunner`, `RunLog`, `PackageRealtimeSession`                 | `kody-runtime` (main binds them cross-script)                               |
| Remaining platform Durable Objects (`UserMeter`, `MCP`, …)          | `kody-platform` (runtime binds them cross-script)                           |
| `APP_DB` / `AUDIT_DB` / KV / R2 / queues / Vectorize / AI           | Shared resources; each worker binds directly (no RPC proxying)              |

Production serves `kody.run` via **zone routes** on the runtime Worker (apex +
`*.kody.run/*`), never a Workers custom domain in that zone. Leave those routes
on `kody-runtime`. Do not detach them from the main worker "so the first runtime
deploy can publish" — that first publish already happened.

## Invariants

- Do not add another `transferred_classes` row for `StorageRunner`, `RunLog`, or
  `PackageRealtimeSession`. The `v1` transfer already applied on production
  `kody-runtime`. The exact set is protected by
  `tools/ci/durable-object-baseline.json`.
- Never add `deleted_classes` for a class that still has live objects unless you
  are following [Deleting a transferred class](#deleting-a-transferred-class).
  Do not add `deleted_classes` for `StorageRunner`, `RunLog`, or
  `PackageRealtimeSession`.
- The committed `from_script: "kody"` in
  `packages/runtime-worker/wrangler.jsonc` is rewritten by
  `tools/ci/runtime-worker-config.ts` to the deployed main script name
  (`kody-production`) at deploy time.
- Preview worker sets are created fresh with `new_sqlite_classes`. Preview
  cannot rehearse a `transferred_classes` migration, and the preview origin
  never bootstraps: it uploads the slim entry after runtime and platform exist
  (see the
  [platform runbook](./platform-worker-migration-runbook.md#invariants)).
- `DynamicCallableWorkflow` is a **new** Cloudflare Workflow on `kody-runtime`
  (`kody-runtime-dynamic-callable-workflows`). Workflows cannot be transferred
  between scripts. Do not try to move that workflow back onto origin.
- Cloudflare transfer rules that made the original move valid still apply to any
  future class move: the source script must still exist and still contain the
  migration history that created the class; the destination must export the `to`
  names; existing ids, storage, and alarms move with the class.

## Later deploys

The merged main-branch deploy workflow encodes deploy order. Merge and watch; do
not run wrangler by hand to "finish" a transfer or to free the package-app zone.

Origin uploads use the same fail-closed classifier as the
[platform runbook](./platform-worker-migration-runbook.md#later-deploys): a
fresh origin script (or an origin that still owns the classes while this worker
owns none) bootstraps with the full entry before this worker's
`transferred_classes` tag runs; the bootstrap workflow uses a distinct name so
it does not collide with `kody-runtime-dynamic-callable-workflows`. Steady-state
origin uploads the slim entry and skip that bootstrap. Ambiguous Cloudflare
state keeps the full entry and does not force a transfer.

When runtime sources change on a steady-state script, the workflow deploys
`kody-runtime` before origin so cross-script bindings stay valid. That order is
binding and healthcheck hygiene. It does not re-apply the `v1` transfer and it
does not republish package-app zone routes as a first-time attach.

UI/blog-only uploads skip runtime. Official guide markdown still skips runtime.

Healthchecks: origin `/health`, runtime `/__runtime/health`. Package apps load
on `https://{username}.kody.run/packages/{kodyId}/...` (the apex only redirects;
it does not serve package code).

## Deleting a transferred class

A class that arrived on `kody-runtime` through `transferred_classes` keeps a
remote binding until a deploy publishes config without that binding. Cloudflare
rejects a same-deploy `deleted_classes` migration while that binding still
exists (error 10061). Existing objects also require the script to keep exporting
the class until `deleted_classes` runs (error 10064). Export a stub, drop the
binding, then add the `deleted_classes` migration and its
`tools/ci/do-deletion-allowlist.json` entry on a later deploy. Preview
`deleted_classes` requires a previous script version that exported the class
(error 10074). A first preview deploy can apply the create and delete tags
together so they elide.

`PackageServiceInstance` is gone from production `kody-runtime` (tag `v2`; no
stub export). Preview applies `v1` `new_sqlite_classes` then `v2`
`deleted_classes` on first deploy so create and delete elide.

Wrangler 4.131+ runs `getDurableObjectClassNameToUseSQLiteMap` on real
`wrangler deploy`, not only dry-run, and that map ignores `transferred_classes`.
The production `v1` tag therefore also lists
`new_sqlite_classes: ["PackageServiceInstance"]` so the local map can apply
`v2`. Do not treat that annotation as a new create: remote `kody-runtime` is
already at tag `v2`, so wrangler does not re-upload `v1`.
