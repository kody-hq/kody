# Checks

Husky hooks, `npm run validate`, and the test commands that gate commits and
pushes. See the [setup index](./index.md) for the other setup pages.

- `git commit` runs lint-staged: `oxlint --fix` on staged JavaScript/TypeScript,
  then `oxfmt` on staged code, JSON, Markdown, CSS and YAML (including
  workflows). For non-docs changes, `node tools/git-hook-checks.ts pre-commit`
  then runs `npm run install:check` and `npm run migrations:check`. It does not
  typecheck. An unreadable staged diff runs both checks. Docs-only means every
  path is under `docs/`, ends in `.md`, `.mdx` or `.mdc`, or is a LICENSE /
  LICENCE / COPYING / NOTICE text file. Source renames to markdown still count
  as code.
- `git push` runs `node tools/git-hook-checks.ts pre-push`. Non-docs pushes run
  `npm run typecheck`, `npm run knip`, then `vitest related --run` separately
  for `node-unit` and `workers-unit`, with `CI=1`. Related inputs are the
  pushed, non-deleted JavaScript/TypeScript source and test paths (all updated
  refs, not just the last commit). Projects with no related tests pass. CI and
  `npm run validate` remain the full gates; local `test:node` and validate are
  unsharded.
- Global pushed paths fall back to full `npm run test:push`: any package.json,
  package-lock.json, vitest*.ts, vite.config.ts, tsconfig*, nx.json,
  project.json, wrangler*.jsonc, migrations directory, `patches/**`,
  `tools/vitest-global-setup*`, or `packages/worker/src/test-support/**`.
  Deleted globals also force full tests. Unreadable pushed paths, or changes
  without usable related sources (such as assets), fall back to full tests.
  Deleted-only source changes have no related inputs but still typecheck.
  Runtime filesystem reads, generated/virtual modules and computed dynamic
  imports can escape dependency selection: related tests are fast feedback, not
  proof equivalent to the complete CI gate.
- Knip and full `test:push` retain independent tree-SHA provenance skips from
  `npm run validate` or successful full pre-push checks, stored in
  `.tmp/git-hook-provenance.json`. Related tests **never** record full
  `test:push` provenance. Typecheck still runs on non-docs pushes, even when
  provenance skips Knip/tests. The tested worktree must remain unchanged and
  match a pushed tree before provenance is recorded.
- Docs-only pushes skip typecheck, Knip and tests. Skills markdown and
  `skills-lock.json` additionally run `node tools/check-skills-lock.ts`;
  executable skill files keep the non-docs checks. Unreadable path lists run the
  skills check too. Branch deletions run no checks. Existing branches diff
  remote and local tips; new branches diff a merge base from `origin/HEAD`,
  `origin/main`, or `main`. Progress logs tick every 30 seconds.
- `test:push` retains serial full Node/Workers suites and ADR 0011 Workers
  isolation. CI uses two Node and two Workers shards, keyed separately in Nx by
  `NODE_TEST_SHARD` and `WORKERS_TEST_SHARD`; local suites remain unsharded when
  these variables are unset. Each Workers shard caps concurrency at three on its
  runner. Workers keeps a 40s test/hook timeout; Node keeps 20s. Each CI Node
  shard retains its conservative watch 700s / hard 840s job budget until new
  sharded timing data supports tightening it. Each Workers shard retains the
  watch 620s / hard 780s attempt budget and one timeout retry.
  `KODY_VALIDATE_LOAD=1` only lowers Workers concurrency during local validate;
  it is not hashed by Nx because it changes neither assertions nor budgets. Keep
  `npm run hooks:ensure` wired through the Cloud Agent dispatcher (see
  [cloud-agents.md](../cloud-agents.md#git-hooks)).
- Push-time hooks intentionally stop short of `npm run validate`; Playwright
  E2E, MCP E2E, and repo-wide format checks remain explicit checks because they
  are heavier than the push gate.
- `npm run validate` is the single authoritative local gate. It is read-only.
  `prevalidate` runs `install:check` first so a snapshot whose `node_modules`
  lags `package-lock.json` fails with `run npm ci` instead of type/bundle
  errors. The check list lives in `tools/validate-gate.ts` and
  `tools/run-validate.ts` runs it. Sibling checks are not aborted on the first
  failure. Suite legs (typecheck, node unit, workers unit, Playwright, MCP) are
  sized like a dedicated CI job. On a machine with at most 4 cores, or with less
  than 24GB of RAM, the gate runs one suite leg and one build leg (worker
  dry-runs, startup bundles, knip) at a time. Starting all of them together
  exhausts a 4-core 16GB VM (#3147). Larger machines still start every leg
  together. `worker-startup-time:check` runs after that phase so the CPU budget
  measures the bundle, not contention from e2e and Worker builds (#2475, #2759).
  The unit-test and Playwright legs set `CI=1` so timeouts, worker limits, and
  Nx cache hashes match GitHub Actions. CI runs the same checks as separate jobs
  (🧹 Static, two 🧪 Node shards, ☁️ Workers, 🔌 MCP, two 🎭 E2E shards,
  aggregated by ✅ Validate). Two E2E shards split the pruned 30-test suite's
  ~420s serial load into roughly 245s including ~35s setup per runner, without
  six copies of setup. Node remains sharded: its pruned full suite still took
  ~379s locally (versus ~479s before pruning). These are local estimates, not
  new CI percentiles. Heavy Validate jobs use
  `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` (set repo variable
  `CI_RUNNER` to another runner label to move them in one place); the final ✅
  Validate gate always runs on GitHub-hosted `ubuntu-latest`. If
  `npm run validate` passes locally, CI will pass. Trusted writers (Cloud Agent
  environments, and same-repo validate) set `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`
  and the write token so Nx uploads task artifacts to
  `https://nx-cache.kody.codes`. Fork `pull_request` validate uses the read
  token and can only GET (see
  [decision 0019](../decisions/0019-self-hosted-nx-remote-cache.md),
  [decision 0038](../decisions/0038-no-nx-cloud-read-write-cache-tokens.md),
  [decision 0040](../decisions/0040-same-repo-writers-may-put-nx-cache.md), and
  [`packages/nx-cache/readme.md`](../../../packages/nx-cache/readme.md)). Those
  cached scripts run through `tools/run-nx.ts` so a rejected remote-cache token
  or a mid-run transport flake cannot fail validate after the tasks already
  succeeded. A token the probe cannot read is unset before Nx starts.
- `npm run install:check` (`tools/check-installed-lockfile.ts`, also
  `control-kody doctor`'s `deps` check) fails when a root or workspace
  dependency's installed version does not match `package-lock.json`, including
  nested workspace installs (for example `packages/worker/node_modules/satori`).
  Cloud Agent snapshots can lag a lockfile bump after `git pull`; this is the
  `run npm ci` hint.
- `npm run docs:check` (`tools/run-check-group.ts docs`) runs temporal language,
  decision-record numbers, markdown file refs, no hosted-execute fallback, and
  mermaid syntax. It continues after a failure and lists each failed member by
  name. File refs fail when markdown cites a repo file that is not in the tree.
  Inline code paths under `packages/`, `docs/`, `tools/`, `e2e/`, `.agents/`, or
  `.github/` are checked when their parent directory exists, and relative links
  are checked always. Generated Wrangler configs (`wrangler-*.generated.json`
  and anything under `.wrangler/`) and local `.env` files are ignored. A path
  the same line names as absent is ignored. Example trees whose parent directory
  is not in the repo are ignored.
- `npm run deps:check` (`tools/run-check-group.ts deps`) runs lockfile peer
  drift, dependency overrides, skills-lock, and the npm floor. Lockfile peer
  drift fails when a locked direct dependency sits inside its declared range but
  outside a peer range that range can still reach; `npm install` rewrites
  `package-lock.json` for that drift (including an optional peer). Overrides
  fail when a root `package.json` override is not documented in
  [dependency overrides](../dependency-overrides.md), when that doc keeps a
  section for a removed override, or when `package.json` repeats a key (JSON
  keeps only the last value). Skills-lock (`tools/check-skills-lock.ts`) fails
  when `skills-lock.json` drifts from the committed skill folders it records.
  The npm floor (`tools/check-npm-install-floor.ts`) fails when root
  `package.json` lacks `devEngines.runtime` (node, `onFail: "error"`) or
  `devEngines.packageManager` (npm, `onFail: "error"`), when `engines.node`
  differs from the runtime range, when the running Node, `.nvmrc`, or any
  `actions/setup-node` `node-version` under `.github` falls outside the runtime
  range, or when the `packageManager` pin falls outside the npm range. In CI (or
  with `--install`) it also runs `npm ci --dry-run` with the lowest npm that
  range allows, so a lockfile only a newer npm can read fails there instead of
  in a fresh clone. `ship-pr` must stay a repo-owned local skill (so
  `skills update` does not reinstall it from kentcdodds/kcd-skills) and its
  `computedHash` must match the folder hash. Edit the skill and refresh
  `computedHash`, or the check fails. `install:check` stays on the git hooks /
  `prevalidate` path and is not part of this group.
- `npm run soft-delete-read-filter:check` and `npm run error-agent-prompt:check`
  run in local `validate` and the CI static job (they are not part of the docs
  or deps groups).
- `npm run deploy-guardrails:check` protects reviewed Durable Object migration
  history and bindings in both Wrangler configs, requires exact allowlisting for
  class deletion, and rejects destructive Cloudflare CLI operations in
  automatically triggered GitHub Actions jobs.
- `npm run workflows:check` (`tools/check-workflow-refs.ts`) rejects
  `steps.<id>.outputs` and `needs.<id>` references in `.github/workflows/*.yml`
  that do not name an existing step or job id. GitHub resolves those
  misspellings to empty strings instead of failing the run, so a typo in
  `deploy.yml` would otherwise first appear on a production deploy. It also
  requires `EXPECTED_DEPLOY_WORKFLOW_CONTRACT` in `deploy.yml` to match
  `DEPLOY_WORKFLOW_CONTRACT_VERSION` in `tools/ci/deploy-workflow-contract.ts`
  (bump both when tip-of-main deploy.yml gains a checkout-coupled requirement).
  It also requires a `server.json` version bump when registry metadata changes:
  the MCP Registry cannot republish a version. It also rejects a `description`
  longer than 100 characters (`ServerDetail.description.maxLength` in the MCP
  server.json schema) so a copy edit fails `validate` instead of the publish
  job. CI passes the PR base SHA or the pre-push `github.event.before` as
  `MCP_REGISTRY_VALIDATION_BASE` so a multi-commit main push that already bumped
  the version is one change.
- `npm run validate:fix` runs `lint:fix` then `format` (formatting last, as in
  the pre-commit hook) and is the explicit opt-in for mutating auto-fixes. It is
  never required to pass `validate`.
- `npm run format` applies formatting updates on its own.
- `npm run test:push` runs the full `test:node` and `test:workers` suites. Husky
  uses it for global/unreadable-path fallbacks; CI always runs full coverage
  (Node split across two shards).
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts, so `npm run validate` self-heals on a fresh machine.
- Use `npm run test:e2e:ensure` when you want to prefetch Playwright browsers
  ahead of time instead of waiting for the first E2E run. On Cloud Agent Linux
  it uses native `unzip` because `playwright install` hangs on that kernel.
  Other machines still run `playwright install` (`--with-deps` is local-only).
  CI caches `~/.cache/ms-playwright` and runs `test:e2e:ensure`, so a
  lockfile-matching cache hit skips the download and never runs `apt-get`
  (`apt-get update` can hang the E2E job past the 15-minute timeout).
- `npm run test:e2e:run` runs the Playwright suite through Nx and depends on a
  cached `worker:prepare-e2e-env` target for `.env` bootstrap plus an uncached
  `worker:prepare-playwright` target that checks the local Chromium install.
- `npm run test:mcp` runs MCP server E2E tests and also depends on the cached
  `worker:prepare-e2e-env` target, which writes `packages/worker/.env` from
  `.env.example` when needed and backfills `COOKIE_SECRET` before the test run.
