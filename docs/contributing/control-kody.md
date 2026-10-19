# control-kody

Cloud Agents verify Kody with one CLI and a Feature Map instead of throwaway
scripts. The CLI wraps `dev:ensure`, seed login, authenticated HTTP, PR preview
smoke, `/health` SHA checks, and the Feature Map.

**Local verification is the default** for UI and API changes: `doctor`, `dev`,
`login`, then `request` / `browse` / `execute` on localhost. Use a PR `preview`
only when local cannot exercise the change — Workers / service bindings, Durable
Objects, real OAuth or inbound third-party webhooks, deploy / wrangler / config,
Artifacts / `packageSave`, or other production-like surfaces. See
[Local limitations](./cloud-agents.md#local-limitations).

```bash
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- login
npm run control-kody -- request GET /session
npm run control-kody -- request GET /account/packages.json
npm run control-kody -- request GET /@jane/-/waiting --dump --contains 'Waiting'
npm run control-kody -- request GET /account/waiting 302 --contains /@jane/-/waiting
npm run control-kody -- request GET /account/organizations/new --contains 'Create organization'
npm run control-kody -- browse --path /account/organizations/new
npm run control-kody -- map waiting
npm run control-kody -- map --check
npm run control-kody -- health --sha <commit>
npm run control-kody -- preview --pr 42 --check /@user-me/-/waiting
npm run control-kody -- browse --origin <preview> --path /@user-me/pkg [--record]
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead] [--org <slug>]
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json] [--org <slug>]
npm run control-kody -- search --origin <preview> --query "packageSave" [--domain packages] [--org <slug>]
```

Same entry: `node tools/control-kody.ts`.

`doctor` checks Node 26, the Playwright browser revision in
`node_modules/playwright-core/browsers.json`, git `core.hooksPath`, installed
root and workspace dependencies vs `package-lock.json` (`run npm ci` when they
drift), origin `/health`, and local APP_DB. Playwright passes only when
`chromium-<rev>` and `chromium_headless_shell-<rev>` each contain
`INSTALLATION_COMPLETE`. A missing revision fails with the unzip steps in
[Cursor Cloud Agent notes](./cloud-agents.md).

`health --sha` succeeds when `/health` `commitSha` equals the argument, uniquely
starts with it (git short SHA, 7+ characters), or is a descendant that contains
it (`git merge-base --is-ancestor`). A later main HEAD deploy still counts as
the merge being live.

## Feature Map

[`.agents/skills/control-kody/references/features/`](../../.agents/skills/control-kody/references/features/README.md)
holds verification notes (how to seed, reach, and assert). The route inventory
is generated from
[`packages/worker/start/routeTree.gen.ts`](../../packages/worker/start/routeTree.gen.ts)
(`FileRoutesByFullPath`). Feature prefixes in
[`tools/control-kody/feature-catalog.ts`](../../tools/control-kody/feature-catalog.ts)
only group that inventory — do not hand-maintain path lists.

`map` prints the generated inventory (optionally filtered by feature id).
`map --check` (and `npm run feature-map:check` in CI) fails when notes cite
unknown routes, a required user-facing prefix has no notes (and no exemption),
or a notes file is missing / orphaned. When you add a new user-facing area, add
a short notes file and a prefix in the catalog; leaf routes under an existing
prefix need no catalog edit.

After `login`, keep using `request` for HTML and JSON assertions. Do not `cat`
the session cookie into `curl` or Python. `request --dump` writes the raw body
to `.tmp/control-kody-body`. `request --contains <text>` fails unless that
substring is in the body (Location is included for redirects). `request` uses
`redirect: 'manual'` (same as `preview --request`), so form POSTs that 302 stay
as status + Location instead of dumping the followed HTML. Without `--dump` or
`--json`, HTML responses print a short outcome (status, Location, title,
alerts). `request` fetches GET/HEAD first and only POSTs `/auth` when the
response is HTTP 401 or login HTML, so public pages such as `/pricing` do not
need a session. Mutating methods log in first when no cookie exists.
`--skip-login` sends the request with no session cookie (anonymous) and skips
login/refresh, even when a cookie file exists for the origin.

`preview` forwards its flags to `preview:manual-test`. `--pr`, `--request`, and
`--check` work without a `--` separator. A `--request` spec accepts the same
trailing `--dump` / `--contains <text>` flags as `request`, for example
`preview --pr 42 --request 'GET /pricing --dump --contains Worker compute'`.

Repeat `--form name=value` to send `application/x-www-form-urlencoded`. Add
`--multipart` for `multipart/form-data`; a `@` value is a file path
(`--form avatar=@./avatar.png`). Most website mutations (org create, profile
upload, secrets) use Start server functions — assert the page with `request` /
`browse`, or mutate via `execute` / MCP, not retired `/account/*.json` action
POSTs. Remaining protocol JSON GETs include `/session`,
`/account/packages.json`, and `/account/export.json`.

`preview --request` leaves redirects manual, and `--contains` also sees
`Location`:

```bash
npm run control-kody -- preview --pr 42 --request 'GET /account/waiting 302 --contains /@user-me/-/waiting'
```

`--header` (repeatable, `Name: value`) sets request headers when a protocol
needs them (`Cookie` and `Content-Type` are rejected because the session and
body own them). The same `--header` works inside a `preview --request` spec.

`browse` reuses the seed cookie stored in `.tmp/control-kody-cookie` (from
`login` or `preview`) and injects it into headed Playwright Chromium via
`addCookies` (same pattern as `e2e/playwright-utils.ts`). It opens `--path`
already signed in. Before launch it runs the same Playwright revision doctor as
`doctor` and fails with the `npm run test:e2e:ensure` / unzip remediation when
Chromium is missing — do not run `playwright install chromium` on Cloud Agents.
Pass `--record` to write video under `.tmp/control-kody-browse` (needs
Playwright ffmpeg: `npx playwright install ffmpeg` — small download),
`--headless` for environments without a display, and `--close-after <ms>` for
scripted smoke. Prefer MCP/API/`execute` for proof; use `browse` only when UI is
under test. Cursor `computerUse` drives its own browser and cannot attach to the
CLI-opened Chromium — for computerUse, open `/login?redirectTo=<path>` with the
public seed credentials instead of retyping a long package URL after landing on
`/account`.

`doctor` checks local APP_DB readiness. A failed local `login` (unmigrated or
unseeded D1) prints:

```bash
npm run migrate:local
node tools/seed-test-data.ts --local
```

## Seed login

`login` and `request` pick credentials from the origin host:

- `localhost` / `127.0.0.1` → `jane@example.com` / `ilikecode`
- anything else (PR preview, production) → `me@kentcdodds.com` / `ilikecode`

Override with `--email` / `--password`. `--cookie-file` defaults to
`.tmp/control-kody-cookie` and stores the origin and email that created the
session, so a leftover local cookie is not sent to a preview and `--email` does
not reuse another user's cookie for the same origin. MCP commands also store the
`--org` slug beside the OAuth token; a different org remints the token and keeps
the login cookie. `preview` uses
[`preview-manual-test`](./preview-manual-testing.md) and its own seed.

`package-create` registers a stub saved package on a PR preview through MCP
`packageGetGitRemote({ create: true, kody_id })`. Pass the package name leaf or
`@owner/leaf` with `--package-name`. It reuses `--origin`, `--email`,
`--password`, `--cookie-file`, `--json`, and `--org <slug>`. Pass
`--package-name <leaf-or-@scope/leaf>` (required; `--kody-id` is an alias),
`--description` (optional), and `--head-ahead` to push one unpublished commit so
the package page can show **HEAD ahead of published**. Do not POST a create
action to `/account/packages.json` — that endpoint has no package-create action.
Logged-in preview testing does not require agents to hand-roll an MCP OAuth
dance — the CLI does it for them. The command refuses `https://kody.codes`.
Package source persistence (`packageGetGitRemote`, `packageSave`, publish) needs
the remote `ARTIFACTS` binding, so run `package-create` against a PR preview,
not `npm run dev`. See [Local limitations](./cloud-agents.md#local-limitations).

`execute` and `search` use the same OAuth client against a preview or local
origin. `execute` reads an ESM module from `--code-file` (default export) and
optional JSON `--params-file`. `--execute-args-file` merges a JSON object into
the execute call, such as a `credentials` call map. `search` takes `--query`,
and optionally `--domain`, `--entity`, and `--limit`. Both refuse
`https://kody.codes`. Do not hand-write a throwaway MCP client script for
preview fixtures. A module that calls `packageSave`, publish, or
`packageGetGitRemote` must use `--origin <preview>`; the local origin cannot
persist package repos.

After the seed user belongs to more than one organization, OAuth authorize
refuses to approve until an org is chosen. Pass `--org <slug>` on `execute`,
`search`, and `package-create` (the slug from `POST /account/organizations/new`,
with or without a leading `@`). The CLI sends that slug as `?org=` on authorize.
The session file records the org next to the bearer token. A later call with a
different `--org`, or with `--org` omitted, remints that token and keeps the
login cookie.

## Daily garden

`@kentcdodds/verification-skill-maintain` runs every day at 06:00
America/Denver. It scans the Feature Map on `kody-hq/kody` `main` and spawns one
Cursor Cloud Agent when the catalog is stale or a required route is unmapped.
The agent updates the map, follows
[`ship-pr`](../../.agents/skills/ship-pr/SKILL.md) for low or medium risk, and
records an outcome. Pause with
`kody:@kentcdodds/verification-skill-maintain/pause`.

This is the same shape as the [friction log](./friction-log.md) and e2e flake
hunter packages: a Kody job, not a GitHub cron.

## Related

- [control-kody skill](../../.agents/skills/control-kody/SKILL.md)
- [Manual preview testing](./preview-manual-testing.md)
- [Cursor Cloud Agent notes](./cloud-agents.md)
