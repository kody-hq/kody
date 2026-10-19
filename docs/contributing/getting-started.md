# kody Setup

<!--
If you're an agent reading this, do as much as you can yourself and then
tell the user what else they need to do themselves.
-->

Use these steps to run `kody` locally and on Cloudflare Workers.

If you are here to understand the purpose of this repository rather than set it
up, read [`docs/contributing/project-intent.md`](./project-intent.md) first.
Some docs and parts of the repo structure reflect starter-oriented conventions,
and the project intent is to build Your agents' cloud for individuals and teams
with an MCP-first architecture.

## Install dependencies

We use npm for installs and scripts, with Node 26 as the runtime.

```bash
npm install
```

To scaffold a **new** project from the epicflare template instead of working
inside this repo, run `npx create-epicflare`.

## Expectations and assumptions

The setup flow assumes:

- Node 26 and npm are installed.
- You run commands from the repo root (needs `nx.json`, `package.json`, and
  `packages/worker/wrangler.jsonc`).
- **Cloudflare D1 and KV**: The checked-in
  [`packages/worker/wrangler.jsonc`](../../packages/worker/wrangler.jsonc)
  declares bindings and `database_name` values but does **not** commit remote
  resource IDs (`database_id`, KV `id` / `preview_id`). Production and preview
  deploys run ensure scripts that create or resolve resources and write
  generated Wrangler configs with real IDs (see
  [`docs/contributing/setup/local-development.md`](./setup/local-development.md)).
  **Local development does not require** provisioning remote D1 or KV;
  `npm run dev` uses local Wrangler persistence.

See `docs/contributing/setup-manifest.md` for required resources and secrets.

For optional Cloudflare offerings (R2, Workers AI, AI Gateway, extra KV), see
`docs/contributing/cloudflare-offerings.md`.

## Preflight checks

Verify Node 26 and that dependencies are installed:

```bash
node --version   # expect v26.x
npm install
```

For deploy work, confirm Wrangler can reach your Cloudflare account:

```bash
npx wrangler whoami
```

## Quick Start (local only)

1. Copy the local environment file and adjust secrets if needed:

```bash
cp packages/worker/.env.example packages/worker/.env
```

`COOKIE_SECRET` and `SECRET_STORE_KEY` are required. The example file includes
placeholder values that work for local development.

2. Apply local D1 migrations:

```bash
npm run migrate:local
```

This writes `APP_DB`, `AUDIT_DB`, and `JOBS_DB` under `.wrangler/state` (the
directory `npm run dev` persists) and copies `packages/worker/.env` from
`.env.example` when the file is missing.

3. Start local development:

```bash
npm run dev:ensure
```

That reuses a healthy origin if one is already up, otherwise starts
`npm run dev`. Either way it prints the resolved URL (default port `3742`) once
`/health` is ok. For an interactive session, run `npm run dev` instead. Health
check:

```bash
curl http://localhost:<port>/health
```

## Full Cloudflare setup (deploy)

Local setup does not create Cloudflare resources. The checked-in Wrangler
template omits remote D1/KV IDs on purpose. The production deploy workflow runs
`node tools/ci/production-resources.ts ensure`, which creates missing D1/KV
resources when needed and writes
`packages/worker/wrangler-production.generated.json` with resolved IDs for that
deploy. Cloudflare deploys do not auto-create those resources from bindings
alone, so the workflow runs that ensure step before migrations/deploy.

1. Configure GitHub Actions secrets and variables for deploy:

- `CLOUDFLARE_API_TOKEN` (Workers deploy + D1 edit + Workers KV Storage:Edit
  access on the correct account)
- `COOKIE_SECRET` (generate with `openssl rand -hex 32` or similar)
- See `docs/contributing/setup-manifest.md` (`GitHub Actions configuration`) for
  full optional secrets/variables and where to get each value.

2. Deploy production through GitHub Actions (`.github/workflows/deploy.yml`).
   That workflow uploads `kody-platform`, `kody-runtime`, `kody-jobs`, and
   origin in the order documented in
   [architecture](architecture/index.md#production-worker-fleet).
   `npm run deploy` from a laptop uploads the **origin** script only
   (`packages/worker`); it is not a full production ship.

## Agent/CI setup

For non-interactive or automated setup:

1. Ensure `packages/worker/.env` exists. `npm run migrate:local` copies it from
   `.env.example` when it is missing.
2. Run migrations and the full validation gate:

```bash
npm run migrate:local
npm run validate
```

`npm run validate` is the single authoritative local gate. It runs format, lint,
typecheck, unit tests, Playwright E2E, MCP E2E, backup/status/nx-cache/jobs/
highlight/api/api-docs/runtime/platform dry-run builds, structure checks
(including `docs:check`, `deps:check`, `soft-delete-read-filter:check`,
`error-agent-prompt:check`, `slop-ratchet:check`, and `knip`), and the
production dependency audit (`audit:prod`), then `worker-startup-time:check`. On
a machine with at most 4 cores, or under 24GB of RAM, suite and build legs run
one at a time so they do not exhaust the machine. Larger machines start every
leg together. CI runs the same checks as separate jobs (node and workers unit
suites on separate runners).

To seed a deterministic test login after migrations:

```bash
node tools/seed-test-data.ts --local
```

Cloudflare resources are managed during deploy. Deploy-time ensure steps inject
real D1/KV IDs into generated Wrangler configs (not into the checked-in
template).

## Local development

See
[`docs/contributing/setup/local-development.md`](./setup/local-development.md)
for local dev commands and
[`docs/contributing/setup/checks.md`](./setup/checks.md) for verification steps.

To create a deterministic test login after migrations, see
[`docs/contributing/setup/seeding.md`](./setup/seeding.md).

## Build and deploy

Build the project:

```bash
npm run build
```

Deploy the origin script to Cloudflare (not the full four-script production
fleet — see [architecture](architecture/index.md#production-worker-fleet)):

```bash
npm run deploy
```
