# Local development

Prerequisites, install, and `npm run dev` notes. See the
[setup index](./index.md) for checks, migrations, seeding, and preview deploys.

## Prerequisites

- Node 26 and npm (used for installs and scripts).

## Install

- `npm install`
- The repo root hosts the Nx workspace metadata; runtime packages live under
  `packages/`.

## Local development

- **Cloudflare D1 and KV**: Local development does **not** require creating or
  linking remote D1 databases or KV namespaces. `npm run dev` runs the worker
  with local Wrangler persistence for D1/KV emulation.
- **Production and preview deploys**: GitHub Actions do not rely on IDs baked
  into the repo. They run `node tools/ci/production-resources.ts ensure`
  (production) or `node tools/ci/preview-resources.ts ensure` (per-preview
  worker name), which create or resolve app/audit D1 databases and the OAuth KV
  namespace, then write generated Wrangler configs with real `database_id` and
  KV `id` values: `packages/worker/wrangler-production.generated.json` and
  `packages/worker/wrangler-preview.generated.json` (gitignored). Preview and
  production also ensure sibling platform/runtime/jobs worker configs and
  `JOBS_DB`. KV titles follow the worker name: production defaults to
  `<worker-name>-oauth`; preview uses `<preview-worker-name>-oauth-kv` (see
  `tools/ci/preview-resources.ts`).
- **Local schema and fixtures**: use `npm run migrate:local` then
  `node tools/seed-test-data.ts --local` (see
  [Seed test account](./seeding.md)). Do not copy a remote D1 database onto a
  laptop for local work.
- `packages/worker/.env` supplies local secrets for `npm run dev`. Copy it from
  `packages/worker/.env.example`, then update secrets as needed. The example
  includes placeholder values for `COOKIE_SECRET` and `SECRET_STORE_KEY`; all
  environments must set both secrets (see
  [`docs/contributing/secret-rotation.md`](../secret-rotation.md)).
  `npm run dev:ensure` and `npm run migrate:local` perform that copy when the
  file is missing.
- `npm run dev:ensure` reuses a healthy origin `/health` on 3742–3751 (prints
  `App running at http://localhost:<port>` and exits 0), waits for a stale
  kody/workerd leftover that is listening but not serving before replacing it,
  then starts `npm run dev` and waits until `/health` is ok. A started server
  writes `.tmp/dev-server.log` (printed as `Dev server log: <path>`). Agents
  should call this instead of reconstructing a startup playbook from terminal
  files.
- `npm run dev` starts the Cloudflare API mock, then Vite (`@pitlane/dev` +
  `@cloudflare/vite-plugin`) so origin SSR runs inside workerd with client HMR.
  Jobs and highlight join as Vite auxiliary workers in every serve, including
  `CLOUDFLARE_ENV=test`. Platform and runtime join only outside the test env.
  Origin `env` bindings come from generated
  `packages/worker/wrangler-local-dev.generated.json` (`WRANGLER_IS_LOCAL_DEV`
  and mock `CLOUDFLARE_API_*`). It sets `CLOUDFLARE_API_BASE_URL`,
  `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` to the local Cloudflare
  API mock Worker for the internal Cloudflare API client, local email sending,
  and Artifacts REST repo create/get/list/token/fork calls. Those REST calls do
  not hit the live Cloudflare Artifacts control plane during normal local
  development. The mock covers only the REST control plane; repo-session git
  clone/pull/push flows need a real Git-capable Artifacts remote and are not
  fully simulated by the local mock. Password reset and email-verification
  messages send through the same Cloudflare Email API helper. Both send from
  `kody@<SYSTEM_EMAIL_DOMAIN>` (falling back to the `APP_BASE_URL` hostname) and
  put that same sending domain on action and asset links when
  `SYSTEM_EMAIL_DOMAIN` is set, so a stale `APP_BASE_URL` cannot pin a retired
  hostname into the message. Local `npm run dev` keeps those action and asset
  links on the request origin so they stay clickable. Set
  `SKIP_CLOUDFLARE_MOCK=1` to skip the local Cloudflare mock entirely. Vite
  streams origin logs live; the background mock buffers logs and only prints
  them if that child process exits with an error.
- MCP **`search`** uses a deterministic offline ranker in tests and when
  `WRANGLER_IS_LOCAL_DEV` is set (no Vectorize, embedding, or Jev Score calls
  required for `npm run test` or unauthenticated local runs). Production uses
  Vectorize plus the Workers AI `@cf/baai/bge-small-en-v1.5` embedding model
  through the `AI` binding, optionally routed through AI Gateway. Ranked search
  can also call `typesafe/jev` when `jev-search-rerank` is on; see
  [`environment-variables.md`](../environment-variables.md) and
  [feature flags](../architecture/feature-flags.md).
- Add new mock API servers by following
  [`mock-api-servers.md`](../mock-api-servers.md).
- `npm run dev:client`, `npm run dev:vite`, and `npm run dev:worker` all start
  the same Vite origin (client + worker in one workerd graph).
- Worker-side HMR: the browser graph hot-swaps components as usual. In the
  Worker environments, an edit that touches a component module (or a module a
  component module imports) reloads the whole worker graph
  (`page reload … (whole worker graph)` in the log; requests in flight wait for
  it), because Vite's incremental SSR update re-evaluates only the importer
  chain and splits Remix component identities across evaluations. Pure server
  chains (handlers, data loaders) keep the incremental update, so module-level
  registration side effects on that path must be idempotent. See
  `tools/vite-worker-whole-graph-reload.ts`. The anonymous marketing HTML cache
  (`caches.default`) is bypassed under `WRANGLER_IS_LOCAL_DEV`, so an anonymous
  tab sees the edit on the next reload instead of a stored page.
- Set `CLOUDFLARE_ENV` to switch Wrangler environments (defaults to
  `production`). Playwright sets this to `test`.

## Multi-worker local pitfalls

Origin Vite serve never passes the committed platform or runtime Wrangler
configs to `wrangler dev` directly. Wrangler applies `--local`, `--var`, and
`.env`-derived secrets only to the **primary** config, registers each worker
under `<name>-<env>`, and treats a secondary config's `ai` binding as
always-remote (dev fails with "Failed to start the remote proxy session";
`"remote": false` is not enough).

On each `npm run dev` start:

- `tools/local-origin-dev-config.ts` writes
  `packages/worker/wrangler-local-dev.generated.json` and injects
  `WRANGLER_IS_LOCAL_DEV`, mock `CLOUDFLARE_API_*`, and `APP_BASE_URL` into
  `vars`. Worker secrets stay in `packages/worker/.env` / `.dev.vars`.
- `tools/local-runtime-dev-config.ts` and `tools/local-platform-dev-config.ts`
  write a gitignored `wrangler-local-dev.generated.json` next to each committed
  config. Those files pin secondary registered names to `kody-runtime` and
  `kody-platform`, drop each secondary `ai` binding, rewrite Durable Object
  migrations for local replay (`tools/local-dev-migrations.ts`: transfers become
  `new_sqlite_classes`, create-then-delete pairs such as
  `PackageServiceInstance` are elided), and inject `APP_BASE_URL`,
  `COOKIE_SECRET`, `SECRET_STORE_KEY`, and `WRANGLER_IS_LOCAL_DEV` from the
  process env. Runtime still rewrites remaining `script_name: "kody"` refs to
  the primary's dev name (`kody-<env>`).
- Jobs and highlight get the same name pin via
  `tools/local-auxiliary-dev-config.ts` (`kody-jobs` / `kody-highlight`, not
  `kody-jobs-production`) so origin `JOBS` / `HIGHLIGHT` bindings resolve.

If runtime-owned paths 503 with `Worker "kody-runtime" not found`, admin usage
500s with `Worker "kody-jobs" not found`, or a secondary worker 500s on missing
vars, inspect those generated files first.

Sibling health paths are not on the origin port: platform serves
`GET /__platform/health`, runtime serves `GET /__runtime/health`, and jobs
serves `GET /health` on their own workers.

### Migration dry-run and PackageServiceInstance

If `npm run dev` or `npm run runtime:build` / startup-bundle dry-run fails with
`Cannot apply deleted_classes migration to non-existent class PackageServiceInstance`,
the config still has the production transfer+delete chain. Wrangler 4.131+
applies that local sqlite-class map on `deploy --dry-run` as well as `dev`.
`wrangler-env.ts` and `tools/check-worker-startup-bundles.ts` write
`wrangler-dry-run.generated.json` with `localizeMigrations` for those bundle
checks. `wrangler check startup` ignores `--config` and loads cwd
`wrangler.jsonc`, so `check-worker-startup-time.ts` snapshots a localized config
into a temp directory. Confirm `localizeMigrations` ran and that the generated
file's **top-level** `migrations` (not only `env.production.migrations`) has no
`PackageServiceInstance` delete. For `npm run dev`, confirm
`wrangler-local-dev.generated.json` instead.

### Origin must not create JobManager

Local `npm run dev` uses `--env production`. The top-level migrations chain in
`packages/worker/wrangler.jsonc` must not create `JobManager` (or JobRunner):
that class lives on `packages/jobs-worker` (ADR 0016) and is not exported from
`packages/worker/src/index.ts`. The committed top-level and preview/test chains
omit the v6/v9 JobManager+JobRunner pair for that reason. If miniflare fails
with `Class extends value undefined is not a constructor` while wrapping
`JobManager`, check that the top-level chain still matches that omission.

### Verifying runtime forwarding

- Binding status in the `npm run dev` output is the reliable signal:
  `env.RUNTIME_WORKER (...) Worker local [connected]` vs `[not connected]`. A
  `/login` redirect on an unauthenticated package-app path is **not** proof of
  forwarding — origin falls through to in-process handlers when the binding is
  missing and those handlers can redirect to `/login` too. A broken connected
  binding tends to surface as `503` (`Worker "kody-runtime" not found`).
- Logged-in package-app requests redirect to the real `https://kody.run`
  (production `PACKAGE_APP_BASE_URL`) — do not follow that handoff into prod.
