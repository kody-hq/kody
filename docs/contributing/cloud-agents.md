# Cursor Cloud Agent notes

Kody runs on Cloudflare Workers: the origin app/MCP worker plus platform,
runtime, jobs, and status workers (Remix 3 UI + OAuth-protected MCP). See
[`local development`](./setup/local-development.md) for the local dev guide;
this document covers Cloud Agent VM gotchas only.

## Node 26

The repo requires Node **>=26** (`engines` in root `package.json`). Cloud Agent
VMs may ship Node 22 at `/exec-daemon/node`, which takes precedence over nvm
unless nvm’s Node 26 bin directory is prepended to `PATH`. Verify with
`node --version` before running scripts.

## Playwright browsers

Playwright's Chromium (used by `npm run test:e2e:run` / `validate`) is
pre-installed in `~/.cache/ms-playwright` and persists in the VM snapshot, so
normally nothing extra is needed. The **non-obvious gotcha**:
`playwright install` (and `test:e2e:install` / `test:e2e:ensure`) **hangs** on
this VM kernel — its Node-based zip extractor stalls on an `io_uring` write
partway through (around `libwidevinecdm.so`), and `UV_USE_IO_URING=0` does not
stop it. The browser zip downloads fine; only the built-in extraction hangs.

If browsers are ever missing (e.g. a Playwright version bump changes the
revision), do **not** rely on `playwright install`. Run
`npm run test:e2e:ensure`: on Cloud Agent Linux it downloads the `browsers.json`
revision and extracts with native `unzip`
(`tools/install-playwright-browsers-unzip.ts`). Other machines still use
`playwright install` (with `--with-deps` locally). A Cloud Agent snapshot
install should run `test:e2e:ensure` after `npm install` so a Playwright bump
does not leave stale `chromium-1208` markers. To do the same steps by hand:

1. Get the revision + Chrome-for-Testing version from
   `node_modules/playwright-core/browsers.json` and the CDN URL printed by
   `npx playwright install chromium` (form:
   `https://cdn.playwright.dev/builds/cft/<cft-version>/linux64/chrome-linux64.zip`
   and `.../chrome-headless-shell-linux64.zip`).
2. `curl -fsSL -o /tmp/c.zip <chrome-linux64.zip>` then
   `unzip -q /tmp/c.zip -d ~/.cache/ms-playwright/chromium-<rev>/`.
3. Repeat for the headless shell into
   `~/.cache/ms-playwright/chromium_headless_shell-<rev>/` (Playwright launches
   headless via the separate headless-shell binary, so both are required).
4. `chmod +x` the `chrome` and `chrome-headless-shell` binaries, then
   `touch INSTALLATION_COMPLETE` in each revision directory.

`control-kody doctor` reads the `chromium` and `chromium-headless-shell`
revisions from `node_modules/playwright-core/browsers.json`. It passes only when
both `~/.cache/ms-playwright/chromium-<rev>/INSTALLATION_COMPLETE` and
`chromium_headless_shell-<rev>/INSTALLATION_COMPLETE` exist. A marker from
another revision fails, and the failure prints the unzip steps for that
revision.

## Nx remote cache

Validate and `test:push` write Nx task artifacts. Those stay local unless the
self-hosted cache is configured. To populate GitHub Actions hits, set both on
the Cloud **environment** (not a one-off `export`). Use the write token
(`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN`). Same-repo Actions validate uses
that token too; only fork `pull_request` jobs use the read token:

```bash
export NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache.kody.codes
export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="$NX_CACHE_WRITE_TOKEN"
```

Use `CI=1` on cached test commands (the repo scripts already do; typecheck and
build hashes ignore `CI`). Leave the variables unset to run without remote
cache. Those scripts run through `tools/run-nx.ts` so a rejected remote-cache
token or a mid-run `/v1/cache` transport flake cannot fail `test:push` or
validate after the tasks already succeeded. A token the probe cannot read is
unset before Nx starts. Each cached script ends with an `Nx remote cache ...`
line that says whether the token reads and writes next to the hit count;
`READ-ONLY` means the environment holds the read token and nothing is uploaded
for CI. See [`packages/nx-cache/readme.md`](../../packages/nx-cache/readme.md).

## Git hooks

Cursor Cloud Agent VMs set `core.hooksPath` to a dispatcher under
`~/.cursor/agent-hooks/` so Cursor can run secret-scan and co-author hooks.
`npm run hooks:ensure` (`prepare` runs it after `husky`) composes that
dispatcher with Husky: `core.hooksPath` stays on the dispatcher,
`.cursor-original-hooks-path` points at `.husky/_`, and `pre-push` /
`pre-commit` / `commit-msg` become dispatcher symlinks when those user scripts
exist. `git push` then runs `npm run knip` and `npm run test:push`
(`test:node` + `test:workers`) when the push changes a non-docs path, and can
upload those Nx remote-cache artifacts before GitHub Actions starts. A docs-only
push skips knip and the suites. A push that touches `skills-lock.json` or
`.agents/skills/` still runs `npm run skills-lock:check`.

Playwright E2E is not in the push hook: that suite is heavier than the unit
gate, and a failed e2e leg skips the unit gate when the push is retried with
`--no-verify`. Bundler artifacts live under `src/node_modules/.kody-generated/`
and wrangler-env clears that collector's additional-module watches and disables
esbuild's source-graph watcher in `CLOUDFLARE_ENV=test`
(`WRANGLER_DISABLE_BUNDLE_WATCH`) so `wrangler dev` does not loop on overlay
create events. Run `npm run test:e2e:run` or `npm run validate` for the
Playwright gate locally. `wrangler-env.ts` defaults `X_LOCAL_EXPLORER=false` on
`dev` because wrangler 4.127+ local explorer writes under `.wrangler/tmp` on
these VMs, retriggers esbuild, and leaves ProxyWorker in a pause/reload loop
after Ready. Opt in with `X_LOCAL_EXPLORER=true`. Wrangler 4.131+ keeps
`Error inside ProxyWorker` request-scoped (workers-sdk#15252), so a transient
ProxyWorker failure no longer exits the Playwright webServer.

Cloud Agent environment `start` should run `npm run hooks:ensure` so a snapshot
boot that skips `npm ci` still composes hooks after Cursor installs the
dispatcher. The command is a no-op on machines without `~/.cursor/agent-hooks`.

## Dependency install

Cloud Agent environment setup and local setup both run `npm install`. CI runs
`npm ci`. A snapshot built before a lockfile bump still has the old
`node_modules` after `git pull`; `npm run install:check` (pre-commit when the
staged diff is not docs-only, plus prevalidate) and `control-kody doctor`'s
`deps` check fail with `run npm ci` instead of downstream type/bundle errors. Do
not treat a cached typecheck as proof the install matches the lockfile — run
`install:check` (or `npm ci`) first. `npm install` keeps `package-lock.json`
unchanged when every locked direct dependency satisfies the peer ranges its
declared range can still reach, including optional peers.
`npm run lockfile:check` (part of `npm run validate` and the CI static job)
rejects a lockfile `npm install` would rewrite, such as an
`@cloudflare/workers-types` pin older than wrangler's peer range. A boot can
already show `package-lock.json` modified, often that `workers-types` bump,
before you install anything yourself. Leave that diff unstaged. Restore it with
`git restore package-lock.json` when you did not change dependencies. A pin
update that `lockfile:check` asks for belongs in its own commit.

## Git worktrees

A worktree lets one VM work on several branches without a second `npm install`.
Do not symlink the whole `node_modules` directory into the worktree.
`node_modules/@kody/*` and `node_modules/@kody-internal/shared` are relative
links to `../../packages/*`. Through a whole-directory symlink they resolve to
the main checkout's `packages/`, so typecheck and tests read the main checkout's
branch instead of the worktree's (#3404).

From the main checkout, link every entry except those workspace scopes, which
are copied as links so they point at the worktree's own `packages/`. The repo
root is often not writable, so put worktrees under `~`:

```sh
main="$(git rev-parse --show-toplevel)"
git worktree add ~/wt/my-branch -b cursor/my-branch origin/main
cd ~/wt/my-branch
mkdir node_modules
for entry in "$main"/node_modules/* "$main"/node_modules/.bin \
  "$main"/node_modules/.package-lock.json; do
  if [ -d "$entry" ] &&
    find "$entry" -maxdepth 1 -type l -lname '../../packages/*' | grep -q .; then
    cp -PR "$entry" node_modules/
  else
    ln -s "$entry" "node_modules/$(basename "$entry")"
  fi
done
ln -s "$main/packages/worker/node_modules" packages/worker/node_modules
```

`realpath node_modules/@kody-internal/shared` should print the worktree path.
Tool caches (`node_modules/.vite`, `.mf`, `.tmp`) stay per worktree. The
worktree's `node_modules` holds only links, copied scope links, and those
caches. After `npm ci` in the main checkout adds or removes a package, run
`rm -rf node_modules` in the worktree and redo the loop. A worktree whose
`package-lock.json` differs from the main checkout's needs its own `npm ci`.

Git hooks are shared. The Cursor dispatcher's `.cursor-original-hooks-path`
names one Husky directory for every checkout, so `git push` from the worktree
runs the main checkout's `.husky` scripts with the worktree as the working
directory (`test:push` tests the worktree). `npm run hooks:ensure`, `npm ci`,
and `npm install` (through `prepare`) rewrite that file to the checkout they run
in. After running one of them in a worktree, run `npm run hooks:ensure` in the
main checkout before `git worktree remove ~/wt/my-branch`, or the main
checkout's commits and pushes lose their Husky hooks.

## GitHub CLI

Cloud Agent `gh` can read issues, PRs, and checks (`gh issue view`,
`gh pr view`, `gh pr checks`). It cannot write GitHub issues or PR review-thread
replies (`403` / GraphQL `Resource not accessible by integration`). That
includes `gh issue comment`, `gh issue close`, `gh issue edit --add-label`, and
review-thread replies.

Write those with `kody:@kentcdodds/github/request` (kody-bot) or Cursor
`ManagePullRequest` `post_comment` / `in_reply_to`. See
[ship-pr](../../.agents/skills/ship-pr/SKILL.md).

## GitHub token expiry mid-run

The `x-access-token` baked into `~/.gitconfig` and `~/.config/gh/hosts.yml` at
VM boot can stop working after tens of minutes (`git push` / `gh` report `401` /
`Invalid username or token`). The metadata socket has no token endpoint. The
environment rewrites those files on its own; there is no supported way to mint a
replacement from this repo.

When `git push` or `gh` fails with bad credentials:

1. Confirm it: `gh auth status` and `git ls-remote origin HEAD`.
2. Check whether the environment has rewritten the files (`stat ~/.gitconfig`
   `~/.config/gh/hosts.yml`). If mtimes are still boot-time, wait and retry
   those two commands. Observed rewrite delay has been on the order of 30–40
   minutes; do not treat that as a contract.
3. Once `gh auth status` is valid again, retry `git push`. Cursor
   `ManagePullRequest` does not replace `git push`.
4. Do **not** invent a Contents API / Git Data API / throwaway-repo transfer as
   kody-bot. That path ships the wrong author and skips the standard AI
   reviewer. If the token is still dead at the end of the run, park the PR and
   say so.

Kody `@kentcdodds/github/request` (kody-bot) can still comment, close, label,
and read when the Cloud Agent git token is stale. Use it for GitHub API writes
that ship-pr already routes through kody-bot — not for pushing the branch.

## Validate on a 4-core VM

`npm run validate` runs the same checks CI runs. CI gives typecheck, node unit,
workers unit, Playwright, and MCP each their own runner. This VM has 4 cores and
about 16GB of RAM. Starting those suite legs plus every worker dry-run at once
drops available memory to tens of megabytes and pushes load well above the core
count, so typecheck, workers, MCP, and Playwright time out or crash even though
each one passes on its own (#3147).

`tools/run-validate.ts` runs one suite leg and one build leg at a time when the
machine has at most 4 cores or under 24GB of RAM. It does not drop checks and it
does not change the GitHub Actions jobs. Larger machines still start every leg
together.

## Focused Vitest runs

Run one file from the repo root. Pass `--project node-unit` for `*.node.test.ts`
or `--project workers-unit` for `*.workers.test.ts`, plus a repo-relative path:

```sh
npx vitest run --project node-unit packages/worker/universal/compute-overage.node.test.ts
npx vitest run --project workers-unit packages/worker/src/billing/credit-wallet.workers.test.ts
```

A command started in `packages/worker` exits with
`Projects definition references a non-existing file or a directory` and a path
ending in `vitest.node.config.ts` under that package. The configs live at the
repo root, and the Nx targets run from there. Filename suffixes, `mcp-e2e`, and
the full error are in
[Running one file](./testing-principles.md#running-one-file).

## Quick commands

| Task               | Command                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install deps       | `npm ci` after pulling a lockfile bump; `npm run install:check` / `control-kody doctor` say so when `node_modules` lags                                                     |
| Start or reuse dev | `npm run dev:ensure` (prints the resolved URL)                                                                                                                              |
| Migrate local D1   | `npm run migrate:local`                                                                                                                                                     |
| Seed test login    | `node tools/seed-test-data.ts --local` (see seeding note below)                                                                                                             |
| Full validate gate | `npm run validate` (CI runs the same checks as parallel jobs)                                                                                                               |
| One Vitest file    | Repo root: `npx vitest run --project node-unit` or `--project workers-unit` plus a repo-relative path ([Focused Vitest runs](#focused-vitest-runs))                         |
| Manual PR preview  | `npm run preview:manual-test` (see preview-manual-testing.md)                                                                                                               |
| App verification   | `npm run control-kody -- doctor` then `login` / `request` (`--dump` / `--contains` for HTML) / `map --check` / `preview` / `health` (see [control-kody](./control-kody.md)) |

## Dev server

- `npm run dev:ensure` is the agent entry point. It probes origin `/health` on
  3742–3751, prints `App running at http://localhost:<port>` and exits 0 when a
  server is already up, waits for a kody/workerd leftover that accepts TCP but
  does not serve `/health` before replacing it, then starts `npm run dev` and
  waits until `/health` is actually ok before printing the resolved URL. If
  `packages/worker/.env` is missing, it copies `.env.example` first so
  `npm run dev` (`--env-file=packages/worker/.env`) can start. If wrangler
  accepts TCP but Remix logs `Invalid environment variables` /
  `Missing APP_DB binding` (or the same for `BUNDLE_ARTIFACTS_KV`,
  `STORAGE_RUNNER`, `PACKAGE_REALTIME_SESSION`, `MCP_CLIENT_HUB`), `dev:ensure`
  exits immediately with that hint instead of waiting 180s. Those bindings come
  from `wrangler.jsonc` via the Vite Cloudflare plugin, not from `.env`; a
  snapshot that cannot provide local D1/KV/DO persist cannot serve `/` or
  `/blog/*`. If the latest wrangler line is Reloading and `/health` still misses
  the budget, the process is left running so a retry can reuse it. UI
  verification opens that real origin (for example `/onboarding`); do not
  substitute a `renderToString` dump of one component.
- `npm run dev` starts the optional Cloudflare API mock, then Vite so origin SSR
  and the client hydrate in one workerd graph. Generated platform and runtime
  configs join as Vite auxiliary workers, with the committed jobs and highlight
  configs (local D1/KV/DO persistence). Non-TTY sessions print `App running at`
  only after `/health` responds.
- Default worker port is **3742** (`cli.ts`); the CLI picks a free port when
  3742 is taken and prints `App running at http://localhost:<port>`.
- Run long-lived interactive `npm run dev` in tmux so the session survives tool
  timeouts. `dev:ensure` detaches the started process so the ensure command can
  exit, tees that process to `.tmp/dev-server.log`, and prints
  `Dev server log: <path>` so a later crash is readable without restarting.
- Health check (no auth): `curl http://localhost:<port>/health` →
  `{"ok":true,"commitSha":...,"commit":...,"pullRequest":...,"deploy":...}`.
  Locally the extra fields are `null` unless a deploy var is set. Platform and
  runtime health paths (`/__platform/health`, `/__runtime/health`) 404 on the
  origin port. After `npm ci` or a merge that changes source under a running
  `dev:ensure` process, `/health` can hang while workerd crash-loops. Stop that
  Vite PID before `npm run test:e2e:run`; the e2e web server refuses to start
  and names the leftover when 3742–3751 is listening but unhealthy.

## Environment file

Copy `packages/worker/.env.example` to `packages/worker/.env` if missing.
`dev:ensure` and `migrate:local` do this copy themselves. `COOKIE_SECRET` and
`SECRET_STORE_KEY` are required for local dev. The file does not create D1, KV,
or Durable Object bindings. Turnstile keys are not required for local boot:
generated local wrangler keeps `SENTRY_ENVIRONMENT=production` from the
production env block but sets `WRANGLER_IS_LOCAL_DEV=true`, and `validateEnv`
skips the production Turnstile boot gate for that flag (#3939). Real production
still refuses to boot without both keys. To exercise the widget locally, the
commented Cloudflare always-pass test values in `.env.example` are enough.

## Local Kody execute (CLI)

When this VM has Node ≥22 (Cloud Agents use Node 26) and `@kodycodes/cli`,
prefer `npx @kodycodes/cli execute --local` over hosted MCP `execute` for
one-off modules and smoke tests — including modules with static `kody:@…`
imports (CLI downloads stamped modules via
`POST /v1/local-execute/package-graph` and embeds them in local workerd; keep
`--local`).

Interactive / desktop agents prefer `cliCredentialBootstrap` (MCP session →
one-shot CLI code) or `kody login`, and omit pasting `KODY_API_TOKEN`. Cloud
Agents without interactive login may put a scoped `kody_at_…` `KODY_API_TOKEN`
in the Cloud **environment** secrets/vars (not in the prompt), or call
`cliCredentialBootstrap` from MCP and run the returned CLI command. Mint via MCP
`api` `tokenCreate` only when bootstrap/login are unavailable; never paste the
token into chat. Guide: [Local CLI execute](../guides/local-execute.md). Skill:
[prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md).
Open API fallback: [Open API](../guides/open-api.md).

### CLI against a PR preview

A preview deploys the Open API edge as its own worker,
`https://kody-pr-<n>-api.kody-a99.workers.dev`, next to the app origin
`https://kody-pr-<n>.kody-a99.workers.dev`. The CLI (`auth bootstrap`,
`execute --local`, `api`) needs that `-api` host. The app origin answers `/v1/*`
with an HTML 404, so `auth bootstrap` against it fails with
`Bootstrap redeem failed (HTTP 404)`. That 404 comes before redemption, so the
code is still unused; retry it against the API host instead of minting a new
one. `npm run control-kody -- preview --pr <n>` prints the host as `API:` plus
an `export KODY_API_URL=…` line (`snapshot.apiUrl` with `--json`). Mint the
bootstrap code on the same preview, then pass the host with `--api-url` or the
exported `KODY_API_URL`:

```bash
export KODY_API_URL=https://kody-pr-<n>-api.kody-a99.workers.dev
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
```

`control-kody execute --origin <preview>` is different: it calls the preview's
`/mcp` (OAuth through the seed login) and never touches the API host.

### Changing the CLI

`@kodycodes/cli` lives in `packages/cli`. `npm run cli:validate` typechecks,
tests, and builds it. `npm run cli:openapi:check` fails when
`packages/cli/src/generated/openapi-routes.ts` drifts from
`packages/worker/src/open-api/operations.ts`.

Merges to `main` that change the CLI in a publishable way (conventional `fix` /
`feat` / `perf`, or a generated route-table diff) publish through
[`.github/workflows/publish-cli.yml`](../../.github/workflows/publish-cli.yml).
The package version in git stays `0.0.0-semantically-released`. Tags are
`cli-vX.Y.Z`, continuing from `cli-v1.26.3`. npm trusted publishing for this
repository and workflow is required; the workflow does not read an npm token.

Keep the merge commit (do not squash away the subtree history). Origin-side
contracts:
[CLI local credential runtime](./contracts/cli-local-credential-runtime.md) and
[CLI streaming gateway-fetch](./contracts/cli-streaming-gateway-fetch.md).

## Seeding a test account

After `npm run migrate:local`, seed the local fixture logins per
[`seeding`](./setup/seeding.md): `kody@example.com` / `ilikecode` (seeded with
the `admin` role) and `jane@example.com` / `ilikecode` (regular account). These
credentials are local test fixtures only. The seed script resolves the worker
Wrangler config automatically (same default as `wrangler-env.ts`), so
`node tools/seed-test-data.ts --local` works without extra flags. Migrate and
seed write D1 under `.wrangler/state`, the directory Vite persists.

## Local limitations

- Vectorize bindings are not emulated locally; capability search uses the
  offline ranker when `WRANGLER_IS_LOCAL_DEV` is set (normal for `npm run dev`).
- `/mcp` returns **401** without OAuth; use browser login or MCP E2E tests for
  authenticated MCP checks.
- Package repo storage (Cloudflare Artifacts, the `ARTIFACTS` binding) is
  remote-only. Wrangler treats that binding as an always-remote type; local
  platform config strips it so `npm run dev` can start, and the origin test env
  never binds it. `packageSave`, publish, and `packageGetGitRemote` / git-remote
  flows then fail on a local origin — often with
  `Binding ARTIFACTS needs to be run remotely`. Verify those paths on a PR
  preview (`control-kody execute --origin <preview>` or
  `package-create --origin <preview>`). Do not migrate, seed, and start
  `npm run dev` just to exercise package source persistence.
