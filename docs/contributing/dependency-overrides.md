# Dependency overrides

This file documents every `overrides` entry in the root `package.json` and
explains why it exists. The overrides member of `npm run deps:check` (part of
`npm run validate` and the CI static job) fails when an override has no `###`
heading here whose first code span is the overridden package (nested overrides
also name each parent in backticks before the `→`), when a heading documents a
package or parent with no matching override, or when `package.json` repeats a
key.

After changing overrides, `npm run audit:prod` is the production-dependency
check (`tools/ci/audit-gate.ts`, which runs `npm audit --omit=dev`). Moderate,
high, and critical findings fail only when the change touches a dependency
manifest: any `package.json` or `package-lock.json` in the workspace, compared
with the merge base of `AUDIT_BASE` (the PR base in CI) or `origin/main`, plus
uncommitted edits. Every other change, and every `main` push, reports findings
as warnings (`::warning` annotations in CI) without failing, so a newly
published advisory does not break unrelated work. Low findings never fail.
`AUDIT_MODE=enforce` or `AUDIT_MODE=report` forces a mode. It is part of
`npm run validate` and the CI static job (see [`checks`](./setup/checks.md)).
Clearing these override targets does not mean every advisory is gone; other
transitive packages can still report findings outside this file's scope.

The scheduled `🔐 Audit bump` workflow (`.github/workflows/audit-bump.yml`) runs
the audit on `main` every day. When it finds advisories it runs `npm audit fix`
and opens or updates a single PR from the `ci/audit-bump` branch, then
dispatches ✅ Validate on that branch (where the audit enforces, because the
lockfile changed). Findings that `npm audit fix` cannot resolve are listed in
that PR body and the job summary; they need an override or floor documented
below. If the open `ci/audit-bump` PR has a commit from anyone other than
`github-actions[bot]`, the workflow keeps that branch and only refreshes the PR
body.

## Dependency bump PRs

Agents often notice the same advisory at the same time. Before opening a PR that
bumps, floors, or overrides a dependency (including an audit fix):

1. Look for an open PR that already touches that package:
   `gh pr list --state open --search "<package> in:title,body"` and the open
   `ci/audit-bump` PR (`gh pr list --state open --head ci/audit-bump`).
2. If one exists, push your fix to that branch or leave it alone. Do not open a
   second PR for the same package.
3. Otherwise open one PR that names the package and advisory in its title, so
   the next agent's search finds it.

## Production overrides

### `@modelcontextprotocol/sdk` → `1.32.1`

Pins a single MCP SDK copy across the workspace and floors it above the current
advisory range. Without this override, npm may hoist conflicting versions from
transitive consumers (`agents`, `@kody/worker`), and `agents@0.22.x` still peers
the vulnerable exact `1.30.0`.

- [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) —
  OAuth client could send credentials to an authorization server chosen by the
  MCP server (`>=1.12.0, <=1.30.1`)

### `@modelcontextprotocol/client` → `2.3.1`

Floors the MCP client above the same OAuth advisory. `agents@0.22.x` still peers
the vulnerable exact `2.0.0`, so this override cannot be removed yet.

- [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) —
  OAuth client could send credentials to an authorization server chosen by the
  MCP server (`>=2.0.0, <=2.1.0`)

### `@modelcontextprotocol/server` → `2.3.1`

Floors the MCP server SDK above the current advisory range. The worker direct
dependency and `agents@0.22.x` still peer vulnerable `2.0.0`, so this override
cannot be removed yet. Related: #4122.

- [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp):
  shared transport or server instances delivered one HTTP client's messages to
  another (`>=2.0.0, <=2.2.0`)
- [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453): one
  HTTP request within the default size limit could exhaust server memory during
  validation (`>=2.0.0, <=2.2.0`)
- [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq):
  server bearer authentication accepted tokens issued for another service
  (`>=2.0.0, <=2.2.0`)

### `esbuild` → `$esbuild`

Forces every transitive esbuild copy onto the root `esbuild@^0.28.2` resolution.
Without this, `@remix-run/test` nests `esbuild@^0.27.1` and lands inside the
current advisory range.

- [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) —
  arbitrary file read when the development server runs on Windows
  (`>=0.27.3, <=0.28.0`)

Keep the root `esbuild` range at or above `0.28.1` so the shared copy stays
outside that advisory.

### `hono` → `>=4.13.7 <5.0.0`

Keeps the transitive hono copy at or above the current advisory floor. Upstream
`@modelcontextprotocol/sdk@1.32.1` still declares `hono@^4.11.4`, which allows
vulnerable releases below `4.13.7`, so this override cannot be removed yet.

The floor is `4.13.7` for:

- [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) —
  `hono/jsx` renders plain strings unescaped in boundary components (`<4.13.7`)

That range also covers the `4.13.5` fixes:

- [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv) —
  `toSSG()` can still write files outside the output directory (`<4.13.5`)
- [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc) —
  unbounded dot-notation nesting in `parseBody()` (`<4.13.5`)
- [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx) —
  query parser reads parameters after the URL fragment (`<4.13.5`)

Earlier floors through `4.12.27` stay covered, including:

- [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) —
  hono/jsx context not isolated per request (`>=4.11.8, <4.12.27`)
- [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59) —
  server-side XSS via JSX escaping bypass in `cx()` (`>=4.0.0, <4.12.27`)
- [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) — API
  Gateway v1 adapter can drop a distinct repeated header value
  (`>=4.3.3, <4.12.27`)

The upper bound `<5.0.0` keeps the override within the same major version to
avoid breaking changes.

### `@hono/node-server` → `>=2.0.10 <3.0.0`

Keeps the transitive `@hono/node-server` copy at or above the current advisory
floor. Upstream `@modelcontextprotocol/sdk@1.32.1` declares
`@hono/node-server@^1.19.9 || ^2.0.5`, which can still resolve a vulnerable 1.x
or a 2.x below `2.0.10`, so this override forces the patched 2.x floor and
cannot be removed yet.

Advisories requiring the 2.x floor:

- [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) —
  path traversal in `serve-static` on Windows via encoded backslash (`%5C`)
  (vulnerable `<2.0.5`, including all remaining 1.x releases)
- [GHSA-9mqv-5hh9-4cgg](https://github.com/advisories/GHSA-9mqv-5hh9-4cgg) —
  follow-on 2.x issue (`>=2.0.0, <=2.0.9`, patched `2.0.10`)

The older 1.x floor (`>=1.19.13`) only addressed
[GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m) and is
stale relative to the advisories above. The upper bound `<3.0.0` keeps the
override within the forced 2.x major.

### `postcss` → `>=8.5.10 <9.0.0`

Resolves a moderate advisory in postcss <8.5.10:

- [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) — XSS
  via unescaped `</style>` in CSS stringify output

PostCSS is pulled transitively by Vite (via `agents` / `vitest`). Upstream Vite
still declares `postcss@^8.5.8`, which allows `8.5.8` / `8.5.9`, so this
override cannot be removed yet even though a fresh resolve often lands on a
newer 8.5.x. No newer PostCSS advisory has raised the patched floor beyond
`8.5.10`. The upper bound `<9.0.0` keeps the override within the same major
version to avoid breaking changes.

### `ip-address` → `>=10.5.1 <11.0.0`

Keeps the transitive `ip-address` copy (via `express-rate-limit`) at or above
the current advisory floor. Upstream still declares `ip-address@^10.2.0`, which
allows `10.5.0`, so this override cannot be removed yet.

- [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q) —
  `Address6.isLinkLocal()` recognizes `fe80::/64` rather than `fe80::/10`
  (`<=10.5.0`)
- [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc) —
  `isPrivate()` misses NAT64 local-use `64:ff9b:1::/48` (`>=10.2.1, <=10.5.0`)

The upper bound `<11.0.0` keeps the override within the same major version.

### `fast-uri` → `>=3.1.8 <4.0.0`

Keeps the transitive `fast-uri` copy (via `ajv` from
`@modelcontextprotocol/sdk`) at or above the current advisory floor. Upstream
still declares `fast-uri@^3.0.1`, which allows `3.1.7`, so this override cannot
be removed yet.

- [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) —
  inconsistent host case normalization via percent-encoded octets
  (`>=3.0.0, <=3.1.7`)

The upper bound `<4.0.0` keeps the override within the same major version.

### `proxy-addr` → `>=2.0.8 <3.0.0`

Keeps the transitive `proxy-addr` copy (via `express` from
`@modelcontextprotocol/sdk`) at or above the current advisory floor. Upstream
`express@5.2.1` still declares `proxy-addr@^2.0.7`, which allows `2.0.7`, so
this override cannot be removed yet.

- [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) — IP
  spoofing via IPv4-mapped IPv6 trust subnet (`>=1.1.0, <2.0.8`)

The upper bound `<3.0.0` keeps the override within the same major version.

### `source-map-js` → `>=1.2.2 <2.0.0`

Keeps the transitive `source-map-js` copy (via Remix packages and PostCSS /
Vite) at or above the current advisory floor. Upstream Remix packages still
declare `source-map-js@^1.2.1`, which allows `1.2.1`, so this override cannot be
removed yet.

- [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) —
  event-loop denial of service through indexed source-map section offsets
  (`>=1.0.0, <1.2.2`)

The upper bound `<2.0.0` keeps the override within the same major version.

### `smol-toml` → `>=1.9.0 <2.0.0`

Keeps the transitive `smol-toml` copy (via `@cloudflare/worker-bundler`) at or
above the current advisory floor. Upstream `@cloudflare/worker-bundler@0.2.5`
still declares `smol-toml@^1.7.2`, which allows `1.8.0`, so this override cannot
be removed yet.

- [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2) —
  quadratic-time `parse()` from `parseKey` rescanning to end of document on each
  key line (`<=1.8.0`)

The upper bound `<2.0.0` keeps the override within the same major version.

### `undici` (under `wrangler` / `miniflare` / `@cloudflare/vite-plugin`) → `>=7.29.1 <8.0.0`

Floors only the Cloudflare 7.x undici copies. The root `undici@6.28.1` is
already on the 6.x patched line and must stay there.

- [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) —
  WebSocket permessage-deflate decompression can crash the process
  (`7.28.0`–`7.29.0`)

The upper bound `<8.0.0` keeps those tools on 7.x.

### `isomorphic-git` → `>=1.40.0 <1.40.8`

A compatibility cap, not an advisory floor. `isomorphic-git@1.40.8` and later
route `git.init` through a `mkdirp` that expects Node-style error codes, which
the `@cloudflare/shell` workspace filesystem does not set, so repo sessions fail
to initialize. Remove the cap once a newer release (or `@cloudflare/shell`)
handles those errors and repo-session tests pass against it.

### `zod` → `4.6.5`

Pins a single Zod copy across the workspace. Without this override,
`@cloudflare/vitest-pool-workers@0.22.0` (exact `zod@4.4.3`) and `@kody/worker`
(`zod@^4.6.5`) resolve two trees, and the Worker-local copy misses
`patches/zod+4.6.5.patch`, which trims `zod/v4/locales` to English-only and
strips unused `compile` / `fromJSONSchema` / `deepPartial` barrel exports for
the startup budget. Keep this pin aligned with the Worker Zod range and refresh
the patch when bumping.

### `sharp` → `>=0.35.5 <1.0.0`

Keeps the transitive `sharp` copies (via `wrangler` / `miniflare` /
`@cloudflare/vite-plugin`) at or above the current advisory floor. Upstream
still declares ranges that allow vulnerable releases below `0.35.5`, so this
override cannot be removed yet.

The floor is `0.35.5` for:

- [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) /
  CVE-2026-96889: librsvg dependency vulnerability (`<0.35.5`)

The upper bound `<1.0.0` keeps the override within the same major version.

## Development overrides

These packages are only reached through dev tooling, so `audit:prod` does not
cover them. The overrides still keep the local and CI toolchain off known
vulnerable releases.

### `brace-expansion` → `>=5.0.12 <6.0.0`

Keeps the `brace-expansion` copy (via `nx` and its `minimatch`) at or above the
current advisory floor. Upstream `nx@23.2.1` pins `brace-expansion@5.0.9`
exactly and `minimatch@10.2.5` declares `^5.0.5`, both of which allow vulnerable
releases, so this override cannot be removed yet.

The floor is `5.0.12` for:

- [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) —
  quadratic-time expansion of the `{a},b}` rewrite (`<5.0.12`)
- [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) —
  uncontrolled recursion on nested brace groups (`<5.0.11`)
- [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) —
  uncontrolled recursion in `parseCommaParts` (`<5.0.10`)

The upper bound `<6.0.0` keeps the override within the same major version.
