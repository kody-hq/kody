# Manual preview testing

Prefer local [control-kody](./control-kody.md) verification (`dev` / `login` /
`request` / `browse` / `execute`) for UI and API changes. Use a PR preview when
local cannot exercise the change: Workers / service bindings, Durable Objects,
real OAuth or inbound third-party webhooks, deploy / wrangler / config, the real
remote Artifacts namespace, or when you need the isolated preview workers,
mocks, and a **logged-in user with the data the change cares about**. Local
`packageSave` / publish use the mock Artifacts API. Medium or high risk recaps
(`extends` / `adds` in
[`.agents/skills/visual-recap/SKILL.md`](../../.agents/skills/visual-recap/SKILL.md))
still need that proof — local first, preview when local is insufficient.

This does not replace `npm run validate` or local control-kody proof. A green
health/login smoke is not evidence that an untested flow works.

## One command

From the repo root, on a pushed PR branch, with `gh` authenticated:

```bash
npm run preview:manual-test
```

Same thing: `node tools/preview-manual-test.ts`, or
`npm run control-kody -- preview --pr <n>` (flags after `preview` go to this
script; a `--` separator is optional).

The script signs in as the preview seed user and keeps that session. The seed
account starts **empty** except the user row — there are no secrets, packages,
or jobs until you create them. Create that data and assert the change as the
same user. For a saved package, use `package-create`:

```bash
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
```

For arbitrary MCP `execute` or `search` as the same seed user (fixtures,
`jobRunNow`, probing `kody:runtime`), use the CLI instead of a throwaway OAuth
script:

```bash
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json]
npm run control-kody -- search --origin <preview> --query "packageSave"
```

Use retained HTTP protocols for session and export checks. Exercise website
reads and mutations through the browser, which calls Start server functions:

```bash
npm run preview:manual-test -- \
  --request 'GET /session' \
  --check /onboarding/step-2
```

`--request` is authenticated HTTP as the seed user. Spec:
`METHOD /path [expected-status] [json-body] [--dump] [--contains <text>]`.
Default success is any 2xx. Example negative check:
`--request 'GET /admin 403'`. `--dump` and `--contains` behave like
`control-kody request`: `--dump` writes the raw body to `.tmp/control-kody-body`
(`-<n>` suffix per request when several dump) and `--contains` fails the check
unless the body includes the text (everything up to the next flag, so
`--request 'GET /pricing --dump --contains Worker compute'` works). They can
also follow the spec as separate flags and apply to the previous `--request`.

`GET /account/export.json` is a bounded metadata manifest (header
`X-Kody-Export-Completeness: manifest-only`). It lists section counts and points
at MCP export capabilities; it does not inline D1 rows, secret names, or other
user payload. Do not use `--contains` on that route to assert saved secrets,
memories, or similar — the check fails even when export works. At most assert
manifest shape, for example
`--request 'GET /account/export.json --contains accountExportSection'`. To
verify exported content, use MCP `accountExportSection` via
`control-kody execute` on the same preview origin. `execute` takes the module
from `--code-file`. Example for `secret_entries` metadata (name only, never the
value):

```bash
mkdir -p .tmp
cat > .tmp/export-secret-entries.ts <<'EOF'
import { kody } from 'kody:runtime'
export default async function main() {
  return await kody.accountExportSection({ section: 'd1_table', table: 'secret_entries' })
}
EOF
npm run control-kody -- execute --origin <preview> --code-file .tmp/export-secret-entries.ts
```

`--json` includes session metadata for the scripted run. For more authenticated
HTTP, use `control-kody request` with the same `--origin` (and `--dump` /
`--contains` for HTML). Do not `cat` the session cookie into `curl` or Python.

`--no-wait` fails immediately if the preview is not up. `--url` skips GitHub
discovery. `--help` lists the rest.

On medium or high risk, running only the default smoke (health + empty login) is
not enough. Add `--request` / `--check` for the flows this PR changes, or run
`control-kody request` against the same origin. Then do a UI pass.

## When a preview exists

Ready-for-review PRs on this repository (not forks, not drafts) get a per-PR
origin worker (`kody-pr-<n>`), sibling platform, runtime, and jobs workers
(`kody-pr-<n>-platform`, `kody-pr-<n>-runtime`, `kody-pr-<n>-jobs`), isolated
app/audit/jobs D1 resources, a Vectorize index, KV, mock workers, and a seeded
login. The workflow comments the URL on the PR. Details of resource names and
cleanup live in [`preview deploys`](./setup/preview-deploys.md).

`/health` `commitSha` is GitHub's `github.sha` for that workflow run. On
`pull_request` events that is the merge commit, not the branch tip, so it can
differ from `HEAD` / `headRefOid`. Preview deploys do not create a per-PR GitHub
Environment, so the script expects the PR head SHA (or `--sha`). It treats
`/health` as ready when `commitSha` equals that expected SHA **or** is a merge
commit that has the PR head as a parent. Pass `--sha` to override the expected
commit.

## DR backup control plane

The origin preview does not run the disaster-recovery backup control plane. That
worker is `kody-production-d1-backups` (`packages/backup-control-plane/`, admin
UI at `https://kody-dr.kentcdodds.com`). `POST /actions/seal-day` and the other
control-plane routes are not served by `kody-pr-<n>`.

`.github/workflows/preview.yml` never deploys this worker.
`.github/workflows/deploy.yml` deploys it from `main` only, in
`deploy-backup-control-plane`, when the 15-commit path filter matches
`packages/backup-control-plane/`, `packages/shared/src/backup-*`,
`tools/ci/backup-resources`, or `deploy.yml` (a manual Deploy dispatch forces it
too). Shared backup helpers that the origin worker imports can still run on a
preview. Behavior that exists only on the control-plane worker cannot.

For a change whose behavior lives only on that worker, an origin preview pass is
not proof. Use the control-plane Node tests
(`packages/backup-control-plane/**/*.node.test.ts`, included by
`vitest.node.config.ts` via `npm run test:node`), `npm run backup:build`
(Wrangler dry-run of that config), and, after merge, the
`deploy-backup-control-plane` job on `main`. See
[disaster recovery](./disaster-recovery.md).

## Seed login

Preview seeding uses a **non-admin** account (the local `jane` companion is not
seeded remotely):

- Email: `me@kentcdodds.com`
- Password: `ilikecode`
- Username: `user-me`

The script signs in through `POST /auth` (Turnstile is off on preview). Sign in
in a browser at `/login` with Email + Password and the **Sign in** button.
Prefer a deep link with `redirectTo` when UI login is still needed, for example
`/login?redirectTo=%2F%40user-me%2Fyour-pkg`, so you land on the page under test
instead of `/account`. Or skip typing entirely with
`npm run control-kody -- browse --origin <preview> --path <path>` after the
scripted session (reuses `.tmp/control-kody-cookie`). `/admin` is expected
to 403. Preview credentials are public, so the seed is intentionally non-admin.
States that only an admin can set (account suspension, outbound-email pause,
account deletion kickoff, fleet feature flags) cannot be reproduced on preview.
For those paths, sufficient evidence is the local admin seed (`kody@example.com`
/ `ilikecode`) plus targeted Workers or unit tests — not a preview `/admin`
session and not raw D1 writes.

The one exception is the operator/CI-only
[migration rehearsal](./preview-migration-rehearsal.md): its `seed` action
creates a site admin on a `kody-branch-*` preview, with private credentials that
leave CI only sealed to the operator's key. PR previews never get an admin.

Do not seed preview D1 from the agent VM with `tools/ci/preview-resources.ts`
unless you are an operator with Cloudflare credentials. Create user data through
supported MCP capabilities with `control-kody execute` / `search`, or use the
browser UI. For a saved package, use
`npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]`.
Package creation uses `packageGetGitRemote({ create: true, kody_id })` with the
package name leaf or `@owner/leaf`. Website-only reads and mutations use Start
server functions, not public JSON action URLs. `/session`, `/auth`, and
`/account/export.json` remain HTTP protocols. Use `control-kody` login rather
than implementing authentication yourself.

`/mcp` stays OAuth-protected; an unauthenticated GET is 401 by design. Logged-in
preview testing does not require agents to hand-roll an MCP OAuth dance — the
CLI does it for them.

`emailSend` on a PR preview still stores the mailbox row (so `emailMessageGet`
and the browser email page can read the text and HTML bodies). Provider delivery
fails with Cloudflare's `could not find domain config of sending domain` because
the per-preview inbox host (`user-me@inbox.kody-pr-<n>.…workers.dev`) is not a
configured sending domain. Treat `status: "failed"` plus that error as the
expected preview send; the stored row is the body round-trip. Production and
local mock/REST fallbacks are the paths that actually deliver.

Two `packageSave` packages on the seed account are both self-authored and share
implicit user-secret read. That is not a locked-secret denial test. To preview
the denial path, publish a listing, install or `communityFork` it under a
different `kody_id`, skip adoption (`community_forks.adopted_at` stays null),
lock the user secret to the original package, then run the fork. Workers
coverage in `package-secret-authority.workers.test.ts` is authoritative for the
denial path; see
[Package approval](../use/secrets-and-values.md#package-approval).

## Feature flags on the preview seed

The preview seed user is non-admin, and experimenter flags stay off until a PR
opts in. Add a label whose name is `preview-flag:` plus a key from
`tools/preview-seed-flag-allowlist.ts`, then let 🔎 Preview run (push, mark
ready for review, add or remove a `preview-flag:` label, or re-run the
workflow). The seed step fails closed for any other key, and `--enable-flag`
with `--remote` refuses every wrangler env except `preview`.

`connection-profiles` is on the allowlist. Label
`preview-flag:connection-profiles` makes the seed step run:

```bash
node tools/seed-test-data.ts --remote --config "$WRANGLER_CONFIG" \
  --email me@kentcdodds.com --password ilikecode \
  --enable-flag connection-profiles
```

After that deploy, open the connected agents page as the seed user and verify
the connection profile controls:

```bash
npm run control-kody -- browse --origin <preview> --path /account/connected-agents
```

Without the label, the next preview seed deletes that allowlisted override, and
the connection profile controls should no longer appear. An unknown
`preview-flag:` label fails the seed step. Adding or removing the label on a
closed pull request does not deploy.

## Logged-in data and UI pass

1. Run the script with `--request` (and `--check` for HTML) covering the change.
2. If you need a longer session, keep using `control-kody request` (or more
   `--request` flags) against the same origin. Do not `cat` the cookie into
   `curl` or Python.
3. Prefer MCP/API/`control-kody` `execute` for proof. Open a browser only when
   UI is under test.
4. When UI is under test, open already signed in with
   `npm run control-kody -- browse --origin <preview> --path <path>` (optional
   `--record` / `--screenshot <path>`). Do not attach `file://` `renderToString`
   dumps as walkthrough evidence. Cursor `computerUse` cannot drive that
   Playwright window — for computerUse, open `/login?redirectTo=<path>` with the
   seed credentials and stay on the preview origin (do not follow package-app
   handoff into production).
5. Record what you saw in the PR.

Do not point Playwright at the preview for the repo E2E suite. Local E2E
(`npm run test:e2e:run`) boots its own worker against `.wrangler/state/e2e`.
`control-kody browse` is the intentional headed exception for preview UI demos.

## If the script cannot find a preview

- **Draft PR** — preview jobs skip drafts. Mark the PR ready for review, wait
  for 🔎 Preview, then re-run.
- **Fork PR** — the workflow skips forks.
- **Workflow still running** — default mode waits (15 minutes). Watch the run
  URL the script prints.
- **Workflow failed** — open the run, fix the deploy, push, re-run the script.
- **Stale URL after a push** — `/health` can still report the previous commit
  until the new 🔎 Preview deploy finishes. The script waits until the workflow
  run for this PR head is `completed`/`success` (unless you pass `--url` without
  `--pr`) and `/health` matches the expected SHA (PR head, or a merge commit
  that has that head as a parent, or `--sha`). Do not treat a healthy worker as
  the new commit until that happens.

Do not `gh workflow run preview.yml` with `target=pr` to "force" a PR preview.
That dispatch checks out the workflow's ref (usually `main`), not the PR head.
Pushing to the PR (or marking it ready) is the deploy trigger.

## Resource reset

Full preview resource delete/recreate remains the operator path in
[`seeding`](./setup/seeding.md#reset-re-migrate-then-seed). The manual-test
script does not create or destroy Cloudflare resources.
