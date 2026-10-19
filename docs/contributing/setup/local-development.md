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
