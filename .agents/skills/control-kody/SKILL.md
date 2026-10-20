---
name: control-kody
description: >
  Drive and verify the Kody app with a Feature Map and one CLI. Use when
  changing UI, account routes, preview deploys, or proving a Cloud Agent change
  with a real origin, session, and /health SHA.
---

# control-kody

Do not invent a throwaway curl script, scrape PR comments by hand, or rediscover
account routes from `routeTree.gen.ts`. Use the CLI and the Feature Map.

```bash
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- login
npm run control-kody -- request GET /session
npm run control-kody -- request GET /@user-me/-/waiting --dump --contains 'Waiting'
npm run control-kody -- map waiting
npm run control-kody -- map --check
npm run control-kody -- health --sha <merge-sha>
npm run control-kody -- preview --pr 42 --request 'GET /session' --check /account/waiting
npm run control-kody -- browse --origin <preview> --path /@user-me/pkg [--record] [--screenshot .tmp/page.png]
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead] [--org <slug>]
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json] [--org <slug>]
npm run control-kody -- search --origin <preview> --query "packageSave" [--domain packages] [--org <slug>]
```

`--kody-id` is an alias for `--package-name`.
`npm run control-kody -- <command>` is the same entry.

After `login`, keep using `request` for HTML and JSON assertions. Do **not**
`cat` the session cookie into `curl` or Python. `--dump` writes the raw body to
`.tmp/control-kody-body`. `--contains <text>` fails unless that substring is in
the body. Cookie files are bound to the origin that created them; `request`
fetches GET/HEAD first and only POSTs `/auth` when the response is HTTP 401 or
login HTML. Public pages such as `/pricing` do not need a session. Mutating
methods log in first when no cookie exists.

`preview` forwards `--pr`, `--request`, and `--check` to `preview:manual-test`.
A `--` separator is optional. `--request` specs take trailing `--dump` /
`--contains <text>` like `request`:
`preview --pr 42 --request 'GET /pricing --dump --contains Worker compute'`.

Website reads and mutations use Start server functions. Use the signed-in
browser for profile uploads, organization creation, and other website actions.
Org scope is explicit validated input, not a Referer header. Create fixtures
through supported MCP capabilities using `execute` / `search` and `--org`.

`request` remains useful for document HTML and protocols such as `/session`,
`/auth`, and `/account/export.json`. `preview --request` does not follow
redirects, and `--contains` also searches the `Location` header.

`browse` reuses the seed cookie from `.tmp/control-kody-cookie` (after `login`
or `preview`) and injects it into headed Playwright Chromium the same way E2E
does (`addCookies`). Opens `--path` already signed in. Optional `--record`
writes video under `.tmp/control-kody-browse`. `--screenshot <path>` writes a
PNG from that live origin — do not attach `file://` `renderToString` dumps as
walkthrough evidence. Prefer MCP/API/`execute` for proof; use `browse` only when
UI is under test. Cursor `computerUse` drives its own browser and cannot attach
to the CLI Chromium window — for computerUse, open `/login?redirectTo=<path>`
with the public seed credentials instead.

`doctor` (and a failed local `login`) print `npm run migrate:local` plus
`node tools/seed-test-data.ts --local` when local APP_DB was never migrated or
seeded.

## Feature Map

[references/features/README.md](./references/features/README.md) is verification
notes (seed, reach, assert). Routes are generated from
`packages/worker/start/routeTree.gen.ts` (`FileRoutesByFullPath`); feature
prefixes in `tools/control-kody/feature-catalog.ts` only group that inventory.
`map` prints the generated inventory; `map --check` fails when notes cite
unknown routes, a required user-facing prefix has no notes (and no exemption),
or a notes file is missing / orphaned. CI runs `npm run feature-map:check`.

Load **one** feature file for the surface you are changing. Run `map --check`
before opening a Feature Map PR.

## Seed users

- Local: `jane@example.com` / `ilikecode` (non-admin)
- Preview: `me@kentcdodds.com` / `ilikecode` (non-admin, empty until you create
  data through JSON APIs, or `package-create` for a saved package). Experimenter
  flags stay off unless the PR is labeled `preview-flag:<key>` for a key in
  `tools/preview-seed-flag-allowlist.ts`. Example: label
  `preview-flag:connection-profiles`, wait for 🔎 Preview, then open
  `/account/connected-agents` with `browse` and check the profile controls.
- `/admin` 403 and `/mcp` 401 are expected for those seeds
- Admin-gated states cannot be preview-tested with the public seed; use the
  local admin account plus Workers or unit tests
- `execute` / `search` reuse the same seed session on preview or local; they
  refuse `https://kody.codes`
- After the seed user creates a team org, pass `--org <slug>` on `execute`,
  `search`, and `package-create`. OAuth otherwise fails with "Choose an
  organization before approving this connection." The cached bearer token is
  keyed by origin, email, and org, so switching `--org` mints a new token and
  keeps the login cookie.
- `packageSave`, publish, and `packageGetGitRemote` / `package-create` work on
  local `npm run dev`: the generated origin config drops the always-remote
  `ARTIFACTS` binding so the mock Artifacts API is used (same as MCP E2E).
  Prefer local `dev` / `execute` / `package-create`; use a PR preview when you
  need the real remote Artifacts namespace. See
  [Local limitations](../../../docs/contributing/cloud-agents.md#local-limitations).

## Proof

CI green is not enough for a user-visible account change. **Local verification
is the default** — prefer `dev` / `login` / `request` / `browse` / `execute` on
localhost before a PR preview:

1. `doctor` then `dev` (migrate + seed if `login` says so)
2. `request` (`--dump` / `--contains`) as the local seed user **with data for
   this change**; when UI is under test, `browse --path <path>` (or computerUse
   with `/login?redirectTo=<path>` and the public seed credentials). Prefer
   MCP/API/`execute` otherwise.
3. Use a PR `preview` only when local cannot exercise the change: Workers /
   service bindings, Durable Objects, real OAuth or inbound third-party
   webhooks, deploy/wrangler/config, the real remote Artifacts namespace, or
   other production-like surfaces (see
   [Local limitations](../../../docs/contributing/cloud-agents.md#local-limitations)).
   Local `packageSave` / publish / git-remote use the mock Artifacts API.
4. After merge, `health --origin https://kody.codes --sha <merge>` (full SHA,
   unique short SHA, or a later descendant HEAD that contains the merge)

See
[docs/contributing/control-kody.md](../../../docs/contributing/control-kody.md)
and [preview-manual-test](../preview-manual-test/SKILL.md).
