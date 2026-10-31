# Seed test account

Use this script to ensure a known test login exists in any deployed environment.
See the [setup index](./index.md) for the other setup pages.

- Local D1 (default):
  - `npm run migrate:local`
  - `node tools/seed-test-data.ts --local`
- `npm run migrate:local` applies `APP_DB`, `AUDIT_DB`, and `JOBS_DB` under
  `.wrangler/state`, the directory Vite persists (`persistState.path`).
  `WRANGLER_PERSIST_TO` in the shell or in `packages/worker/.env` selects
  another directory for `npm run dev`, `npm run migrate:local`, and local seed.
  A shell value wins over the file. `--persist-to` wins over both.
  `node tools/seed-test-data.ts --local` inserts the fixture users into that
  `APP_DB`.
- `npm run migrate:local` copies `packages/worker/.env.example` to
  `packages/worker/.env` when that file is missing (the same copy
  `npm run dev:ensure` performs) before it loads the file.
- Local D1 with custom persisted state:
  - `node tools/seed-test-data.ts --local --persist-to .wrangler/state/e2e`
  - `npm run migrate:e2e` applies the same three databases to
    `.wrangler/state/e2e`
- Remote D1:
  - `node tools/seed-test-data.ts --remote --config <wrangler-config-path>`
  - Add `--env <name>` when the config uses environment-scoped bindings and the
    environment is not already set via `CLOUDFLARE_ENV`.
- Default fixture credentials (both use password `ilikecode`):
  - `kody@example.com` — seeded with the `admin` role so RBAC features (the
    `/admin` pages) are testable out of the box
  - `jane@example.com` — regular account (`user` role only), seeded alongside
    the primary account for testing the non-admin side of RBAC (local seeding
    only; never seeded into remote environments)
- Each seeded account also gets a sample user-lane Google integration with
  Personal and Work connections so `/@<slug>/-/integrations` can be exercised
  without a live OAuth dance.
- Local-only account UI fixtures (no ARTIFACTS binding, no control-kody
  command):
  - `--saved-packages <n>` upserts `n` metadata-only `saved_packages` rows per
    seeded account (deterministic ids; no `entity_sources` or published
    artifacts). Enough for package pickers such as package collaborators.
  - `--enable-flag <key>` upserts a per-user override that forces the registry
    flag on for each seeded account (repeatable). Locally, keys must exist in
    `packages/worker/universal/feature-flags/registry.ts`.
  - Example for the flagged profiles UI as jane (and kody when using defaults):
    - `node tools/seed-test-data.ts --local --saved-packages 40 --enable-flag profiles`
- Remote `--enable-flag` is accepted only when the wrangler env is `preview` (an
  explicit `--env preview`, a config path whose name contains `preview`, or
  `CLOUDFLARE_ENV=preview`). Production and every other env fail closed. Remote
  keys must also be on `tools/preview-seed-flag-allowlist.ts`. Preview deploys
  pass those keys only when the PR has a matching `preview-flag:<key>` label.
  See
  [Manual preview testing](../preview-manual-testing.md#feature-flags-on-the-preview-seed).
- These credentials are a test fixture only and should not be used to describe
  product behavior. Pass `--no-admin` to seed the default account without the
  admin role.
- Choose explicit fixture credentials when needed (custom accounts are non-admin
  unless you pass `--admin`):
  - `node tools/seed-test-data.ts --email <email> --password <password>`
- When changing DB schema/model definitions or migrations, review
  `tools/seed-test-data.ts` and update it so seeded data matches the new model
  and stays useful for local and preview verification.

## Reset, re-migrate, then seed

For a full local reset before seeding, delete the local Wrangler persistence
directory (dropping individual tables does not work: Wrangler's `d1_migrations`
tracking table would still mark the migrations as applied, so re-running them
would recreate nothing):

1. Delete local persisted state:
   - `rm -rf .wrangler/state packages/worker/.wrangler packages/jobs-worker/.wrangler`
2. Re-apply migrations:
   - `npm run migrate:local`
3. Seed test account:
   - `node tools/seed-test-data.ts --local`

For preview environments, we do a full resource reset:

1. Delete preview resources:
   - `node tools/ci/preview-resources.ts cleanup --worker-name <preview-worker-name>`
2. Recreate preview app resources and config:
   - `node tools/ci/preview-resources.ts ensure --worker-name <preview-worker-name> --out-config packages/worker/wrangler-preview.generated.json`
3. Recreate preview jobs-worker resources and config:
   - `node tools/ci/jobs-worker-resources.ts ensure --env preview --worker-name <preview-worker-name>-jobs --host-worker-name <preview-worker-name> --jobs-d1-name <preview-worker-name>-jobs-db --out-config packages/jobs-worker/wrangler-preview.generated.json`
     (`--jobs-d1-name` is the `jobs_d1_database_name` line that step 2 prints)
4. Re-apply remote migrations:
   - `CLOUDFLARE_ENV=preview node ./wrangler-env.ts d1 migrations apply APP_DB --remote --config packages/worker/wrangler-preview.generated.json`
   - `CLOUDFLARE_ENV=preview node ./wrangler-env.ts d1 migrations apply AUDIT_DB --remote --config packages/worker/wrangler-preview.generated.json`
   - `CLOUDFLARE_ENV=preview node ./wrangler-env.ts d1 migrations apply JOBS_DB --remote --config packages/jobs-worker/wrangler-preview.generated.json`
5. Seed test account:
   - `CLOUDFLARE_ENV=preview node tools/seed-test-data.ts --remote --config packages/worker/wrangler-preview.generated.json`
