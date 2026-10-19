# Checks

Husky hooks, `npm run validate`, and the test commands that gate commits and
pushes. See the [setup index](./index.md) for the other setup pages.

- `git commit` runs the Husky `pre-commit` hook. It applies `oxlint --fix` to
  staged JavaScript/TypeScript files, then formats staged
  JavaScript/TypeScript/JSON/Markdown/CSS/YAML files (including
  `.github/workflows`) with `oxfmt`. Lint autofixes (for example merged
  duplicate imports) are unformatted, so formatting always runs last. When the
  staged diff includes a path that is not docs-only, or when that diff cannot be
  listed, it also runs `npm run install:check`, `npm run typecheck`, and
  `npm run migrations:check`. Typecheck runs against the **staged** tree
  (`git stash --keep-index` when unstaged changes exist) so a warm worktree or
  Nx cache of unstaged fixes cannot greenlight a broken index (#3695). A
  docs-only diff skips those three commands. `install:check` runs first so a
  snapshot whose `node_modules` lags `package-lock.json` fails with `run npm ci`
  instead of a typecheck that can look green from a stale remote cache.
  Docs-only means every path is under `docs/`, ends in `.md`, `.mdx`, or `.mdc`,
  or is a `LICENSE` / `LICENCE` / `COPYING` / `NOTICE` text file. A source file
  in the same commit, including a comment-only edit or a source file renamed to
  markdown, runs all three checks.
- `git push` runs the Husky `pre-push` hook. It executes `npm run test:push`
  (`CI=1` `test:node` + `test:workers`) when any updated ref changes a path that
  is not docs-only, or when the pushed paths cannot be listed. When the pushed
  commit's tree SHA is already recorded green from a successful
  `npm run validate` (or a prior pre-push `test:push`) under
  `.tmp/git-hook-provenance.json`, the hook skips `test:push` and logs that
  provenance hit (#3653 / #3719). Progress lines tick every 30s while a script
  runs so a long workers-unit leg is not a silent hang (#3547); ADR 0011
  workers-unit isolation is unchanged. A docs-only range skips the suites. A
  push that changes `skills-lock.json` or any path under `.agents/skills/` also
  runs `npm run skills-lock:check`. `skills-lock.json` counts with docs for this
  hook: a push of only the lock, skill markdown, and other docs skips
  `test:push`. A non-markdown file under `.agents/skills/` (a script or a test)
  still runs `test:push`, as does any other source file. An unreadable push path
  list runs the skills-lock check too. Deleting a remote branch skips the suites
  and the skills-lock check. An update diffs the remote tip against the local
  tip, so a later docs-only push does not retest commits already on the remote.
  A new branch diffs against the merge base of `origin/HEAD`, `origin/main`, or
  `main` (never the branch being created). Those suites are the same Nx targets
  the CI Node / Workers jobs run, so a remote-cache hit is possible after a push
  that runs them. Bundled guides and other markdown are docs-only, so the local
  suites skip them. `npm run validate` and CI run those suites for every pull
  request. Playwright E2E stays in `npm run validate` and the CI E2E job. The
  push hook stops short of that suite because Playwright E2E is heavier than the
  unit gate, and a failed e2e leg skips the unit gate when the push is retried
  with `--no-verify`. Bundler artifacts live under
  `src/node_modules/.kody-generated/`. Local origin development uses Vite;
  `wrangler-env.ts` still wraps D1/types and sibling worker deploys. Playwright
  sets `CLOUDFLARE_ENV=test` so Vite skips platform/runtime auxiliary workers.
  Cursor Cloud Agent VMs keep Cursor's hook dispatcher as `core.hooksPath` and
  compose Husky through `npm run hooks:ensure` (`prepare` runs it after `husky`;
  Cloud Agent environment `start` should run it too) so `pre-push` still reaches
  `.husky/_` — see [cloud-agents.md](../cloud-agents.md#git-hooks). Vitest's
  default `testTimeout` is 20s so the workers pool's first Durable Object RPC in
  a file (~10s) does not fail the default budget (see
  [decision 0011](../decisions/0011-workers-unit-pool-harness.md)); the push
  gate also sets `CI=1` so worker count and Nx cache hashes match GitHub
  Actions. `vitest.workers.config.ts` gives workers-unit a 40s test/hook budget
  everywhere (CI, validate, local) because the pool's cold DO RPCs stretched
  past 20s under load (#2939); node-unit keeps 20s. Full `npm run validate` sets
  `KODY_VALIDATE_LOAD=1` on the `test:workers` leg, which only lowers
  `maxWorkers` to 2 under the parallel gate without changing production startup
  CPU budgets (Cloud Agent load flakes: #2475, #2939;
  `tools/validate-load-contract.node.test.ts` locks the validate script shape).
  The flag is not part of any Nx cache hash: validate and CI verify the same
  budget, so the `test-workers` artifact validate uploads is the one CI's
  Workers job (which runs without the flag) looks up.
- Because the commit hook already enforces formatting, lint fixes,
  install:check, and typechecking for commits that include code, agents do not
  need to run those checks separately before every code commit unless they want
  earlier feedback or are validating a larger change set before opening a PR.
  Docs-only commits format staged markdown. Typecheck, install:check, and the
  unit suites for those commits stay on `npm run validate` and CI.
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
  (🧹 Static, 🧪 Node, ☁️ Workers, 🔌 MCP, sharded 🎭 E2E, aggregated by ✅
  Validate). Heavy Validate jobs use
  `runs-on: ${{ vars.CI_RUNNER || 'warp-ubuntu-latest-x64-4x' }}` (set repo
  variable `CI_RUNNER=ubuntu-latest` to drop WarpBuild in one place); the final
  ✅ Validate gate always runs on GitHub-hosted `ubuntu-latest`. If
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
  drift, dependency overrides, and skills-lock. Lockfile peer drift fails when a
  locked direct dependency sits inside its declared range but outside a peer
  range that range can still reach; `npm install` rewrites `package-lock.json`
  for that drift (including an optional peer). Overrides fail when a root
  `package.json` override is not documented in
  [dependency overrides](../dependency-overrides.md), when that doc keeps a
  section for a removed override, or when `package.json` repeats a key (JSON
  keeps only the last value). Skills-lock (`tools/check-skills-lock.ts`) fails
  when `skills-lock.json` drifts from the committed skill folders it records.
  `ship-pr` must stay a repo-owned local skill (so `skills update` does not
  reinstall it from kentcdodds/kcd-skills) and its `computedHash` must match the
  folder hash. Edit the skill and refresh `computedHash`, or the check fails.
  `install:check` stays on the git hooks / `prevalidate` path and is not part of
  this group. Per-check scripts still exist for targeted runs.
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
- `npm run test:push` runs the same `test:node` and `test:workers` suites
  enforced by the Husky `pre-push` hook and by the CI Node / Workers jobs.
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts, so `npm run validate` self-heals on a fresh machine.
- Use `npm run test:e2e:install` when you want to prefetch Playwright browsers
  ahead of time instead of waiting for the first E2E run. On Cloud Agent Linux,
  `test:e2e:ensure` (the same script `test:e2e:install` runs) uses native
  `unzip` because `playwright install` hangs on that kernel. Other machines
  still run `playwright install` (`--with-deps` is local-only). CI caches
  `~/.cache/ms-playwright` and runs `test:e2e:ensure`, so a lockfile-matching
  cache hit skips the download and never runs `apt-get` (`apt-get update` can
  hang the E2E job past the 15-minute timeout).
- `npm run test:e2e:run` runs the Playwright suite through Nx and depends on a
  cached `worker:prepare-e2e-env` target for `.env` bootstrap plus an uncached
  `worker:prepare-playwright` target that checks the local Chromium install.
- `npm run test:mcp` runs MCP server E2E tests and also depends on the cached
  `worker:prepare-e2e-env` target, which writes `packages/worker/.env` from
  `.env.example` when needed and backfills `COOKIE_SECRET` before the test run.
