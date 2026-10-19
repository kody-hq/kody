# @kodycodes/cli

Install [Kody](https://kody.codes) as a remote MCP server in local agents, and
call Kody's Open API from the terminal. `kody login` uses Client ID Metadata
Documents (SEP-991) once, then stores a `kody_at_…` device token.

**Long term, use Kody through the host MCP connection** — `search` and `execute`
in Cursor, Claude Code, or another client. This CLI writes that config. Keep
`kody login` / `kody search` / `kody execute` for bootstrap, scripts, or hosts
that cannot run MCP.

```bash
npx @kodycodes/cli install
npx @kodycodes/cli skill install
```

Copyright © 2026 [Kent C. Dodds](https://kentcdodds.com). MIT licensed.

## Install the MCP server

```bash
npx @kodycodes/cli install
```

`kody install` lists **running local** agents (Cursor, Claude Desktop, VS Code,
Goose, Claude Code, Codex, Windsurf, Zed, and similar) and writes each host's
remote MCP entry for `https://kody.codes/mcp`. Common host formats go through
[`add-mcp`](https://www.npmjs.com/package/add-mcp). It does not list web
clients. For ChatGPT, Claude.ai, and Grok, use
[kody.codes/onboarding](https://kody.codes/onboarding).

After install, the CLI prints a prompt you can paste into the configured agent
to continue onboarding. Host OAuth stays in that client — `kody login` is only
for the CLI itself.

```bash
npx @kodycodes/cli skill install
```

copies the getting-started skill into Claude Code / Cursor / Agents. That skill
also tells the agent to prefer the MCP server over the CLI.

`--mcp-url` or `KODY_MCP_URL` overrides the default `https://kody.codes/mcp`.

## CLI as a local client

Optional. Use when you need a scripted or headless client instead of a host MCP
connection.

```bash
npm install -g @kodycodes/cli
kody login                 # browser picks the org; adds that org login
kody login --org acme      # bind / replace the acme login; other orgs stay
kody org list              # show logged-in orgs (* = active)
kody org use beta          # switch active org (agents); bare `org use` opens a TTY chooser
kody execute --org acme …  # one-shot org override (also: KODY_ORG=acme)
```

Or run via `npx @kodycodes/cli` without a global install.

Each `kody login` adds an org (chosen in the browser, or via `--org`).
Re-logging into an org that is already stored replaces only that org's
credential. Org-scoped commands (`execute`, `search`, `whoami`, `api`, …) take
`--org <slug>` or `KODY_ORG` (flag wins, then env, then the active org).
`kody logout` removes the active org; `kody logout --org <slug>` removes one
org. Git auth stays user-wide (`kody auth setup-git` once covers every repo
across orgs). Existing single-org keychain credentials migrate silently into the
multi-org store as the active org (no re-login).

## Commands

| Command                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kody install`                                    | Detect running local MCP clients, write their config, and start host OAuth. **Recommended long-term path.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `kody skill install`                              | Copies the getting-started skill into Claude Code / Cursor / Agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kody login`                                      | Browser OAuth (CIMD + PKCE) for the CLI itself. Adds/replaces one org login (browser picker, or `kody login --org acme`) and keeps other org logins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kody org list`                                   | Lists logged-in orgs and marks the active one. `--json` for agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `kody org use [<slug>]`                           | Switches the active org. With a slug (agents) switches directly; with no slug on a TTY opens a chooser; without a TTY pass a slug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `kody logout`                                     | Removes the active org login (or `--org <slug>` for one org) and clears a stored bootstrap/API token when appropriate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `kody status`                                     | Shows CLI login / stored API token state without printing secrets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `kody auth bootstrap --code`                      | Redeems a one-shot `kody_bc_…` from MCP `cliCredentialBootstrap` and stores the resulting `kody_at_…` for `execute --local` (never prints the token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kody auth bootstrap --scopes`                    | Opt-in extra scopes: mints the code itself by passing `scopes` to `cliCredentialBootstrap` (with `--token`, else the `kody login` session, else a stored token), then redeems and stores it. See [Opt-in scopes](#opt-in-scopes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kody auth setup-git`                             | Installs a Git credential helper for `https://kody.codes/@owner/name.git` (persistent `kody_at_…`, user-owned token with `package:read`/`package:write`). See [Git HTTPS](#git-https-setup-git).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kody auth remove-git`                            | Inverse of `setup-git`: clears Kody HTTPS git helpers, revokes the stored API token, deletes it from the keychain. Leaves `kody login` alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kody git-credential`                             | Credential helper invoked by Git after `setup-git` (`get` / `store` / `erase`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kody whoami`                                     | Confirms the CLI MCP connection and lists tools. With a scoped API token (and no login), shows token identity via the Open API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kody search [query]`                             | Calls Kody `search` from the CLI (prefer the host MCP tool). Token-only auth uses Open API `GET /v1/search`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `kody api <operationId>`                          | Thin Open API wrapper matching the MCP `api` tool: `operationId` + flat `--params` JSON. Auth: `--token` / `KODY_API_TOKEN` / stored `auth bootstrap` token. The parsed `/openapi.json` route map is cached under the Kody cache dir keyed by the document's `ETag` and revalidated with `If-None-Match` on each run.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kody package publish`                            | Thin wrapper for `packagePublishExternalPush`. Optional positional `@owner/leaf`, bare leaf name, or package UUID (names are resolved to the package UUID via `packageList`); extra fields via `--params`. Same auth as `kody api`. Prints the API JSON and exits **0 on HTTP 2xx**, including refusal statuses (`checks_failed`, `locked`, `approval_required`, `not_fast_forward`) — read `status` in the body. Network failures exit 1; `--json` adds `{ error, message, sent }` on stdout (`sent: false` = not sent; `sent: "unknown"` = maybe sent — prefer `kody api workflowRunList` before retry). Re-publishing the same commit is safe (durable dedupe / `already_published`).                                                        |
| `kody package collaborators` / `grant` / `revoke` | Who can use one package, and add or remove teams and members of the org (`--org`). `<package>` is `@owner/leaf`, the kody id, or the package id. `grant <package> --team <slug>\|--user <username> [--preset use\|contribute\|manage]` (default `use`) adds or changes a collaborator via `packageCollaboratorSet`; people outside the org are refused. `revoke <package> --team\|--user\|--grant <grant_id>` removes one via `packageCollaboratorRemove`. Needs Manage on the package and a token with `package:manage_access` (`auth bootstrap --scopes …,package:manage_access`). Prints a summary, or JSON with `--json`.                                                                                                                   |
| `kody execute`                                    | Calls Kody `execute` from the CLI (`--invoke`, `--code`, `--file`, or stdin via `--file -`). With a scoped API token and no login (or with `--token`), cloud execute goes through CapabilityProxy → `kody.execute` — no `kody login`. Add `--local` to run the module (and static `kody:@…` package modules) on this machine instead. `--credential key=name` (repeatable; `org:name` / `personal:name` / empty `=` for none) picks ADR 0068 credentials for `--local` or a `kody login` MCP session. `--allow-private-network` opts local execution into private and local network access. `--target prod\|mock` (default `prod`) sends CapabilityProxy / search hops to prod or the built-in CLI mock; `--target mock` implies local workerd. |
| `kody dev`                                        | Local testing for unpublished packages. Serves `kody.app.entry` on localhost via workerd with hot reload. Subcommands: `fetch`, `job`, `webhook`, `emit`, `check`. Default `--target mock` (scratch storage, fake credentials). Covers exports, webhooks, schedules (run-once), and subscriptions. See [Local package testing](#local-package-testing-kody-dev).                                                                                                                                                                                                                                                                                                                                                                                |

`--json` prints structured MCP results. On command failures it also prints a
JSON error object on stdout (`error`, `message`, and when a network hop failed
before an HTTP response, additive `sent: false | "unknown"`).

## Token-authenticated execute (no `kody login`)

Agents already on Kody MCP should prefer `cliCredentialBootstrap` →
`kody auth bootstrap --code …` (ADR 0056) so a one-shot `kody_bc_…` seeds the
CLI store without pasting `kody_at_…` into chat. Interactive humans can use
`kody login`. Scoped API tokens (`kody_at_…`, from bootstrap redeem,
`tokenCreate`, or `POST /v1/tokens`) authenticate the Open API and
CapabilityProxy. They never replace MCP OAuth on `/mcp`. The CLI uses that token
path when you pass `--token` / `KODY_API_TOKEN` and are not logged in (or when
you pass `--token` explicitly):

```bash
# Preferred for agents on MCP (no tokenCreate, no second OAuth):
# 1. MCP api / kody.cliCredentialBootstrap → { bootstrap_code, cli_command }
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js

export KODY_API_TOKEN=…   # scopes: local-execute (+ search:read for search)
# Cloud execute — module runs in Kody's sandbox via CapabilityProxy → kody.execute
npx @kodycodes/cli execute --code 'export default async () => ({ ok: true })'
# Same token, module runs on this machine
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'
npx @kodycodes/cli search "what can you do"
npx @kodycodes/cli whoami
npx @kodycodes/cli api usageGet --params '{}'
```

- Neither bootstrap store, `kody login`, nor a token → the error prefers
  `cliCredentialBootstrap` → `auth bootstrap`, then `kody login`, then
  `tokenCreate` for CI/headless (`--token` / `KODY_API_TOKEN`).
- For `execute --local` specifically: `--token` / `KODY_API_TOKEN` wins when
  set; else a stored bootstrap/API token from `auth bootstrap`; else the stored
  `kody login` OAuth access token as Bearer only when the API and MCP URLs are
  paired (no under-the-hood `tokenCreate`). The default pair is
  `https://api.kody.codes` and `https://kody.codes/mcp`; preview workers pair
  when the API worker name adds `-api`, and loopback hosts pair at any port. For
  a different API origin, use `auth bootstrap --api-url <origin>` or set
  `KODY_API_TOKEN`. The Open API must accept that OAuth bearer on
  CapabilityProxy / package-graph
  ([kody-hq/kody#2812](https://github.com/kody-hq/kody/issues/2812)); until then
  use bootstrap or a scoped `kody_at_…` token.
- Wrong/expired token → 401 with a mint-fresh-token message (or the OAuth
  platform-gap message when the bearer is login OAuth).
- Wrong scopes → the error names the missing scope and the exact command to mint
  a token that adds it (see [Opt-in scopes](#opt-in-scopes)). When your org role
  lacks the permission, it says so instead: a new token cannot add it, and an
  org Owner has to grant it.
- Account flag off → the error includes `feature_disabled` and the
  `local-execute` feature flag. Another token does not bypass that flag.
- Prefer the env var so the token stays out of shell history and `ps`.
- Never scavenge host MCP OAuth tokens from disk (ADR 0053).

## Opt-in scopes

Bootstrap tokens default to least-privilege local-execute scopes (no
`package:write`, for example). Opt in to more when a task needs them:

```bash
# After `kody login` (mints any scope your org role grants):
npx @kodycodes/cli auth bootstrap --lifetime short \
  --scopes org:execute,org:read,package:execute,package:read,package:write

# Agents on MCP without `kody login`: pass scopes when minting the code
# cliCredentialBootstrap({ lifetime: "short", scopes: ["org:execute", "org:read", "package:execute", "package:read", "package:write"] })
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
```

- `--scopes` replaces the default list, so include every scope you need.
- The CLI passes the list straight to `cliCredentialBootstrap`. It mints with
  `--token` when given, else the `kody login` session, else `KODY_API_TOKEN` /
  the stored token. A token can only mint scopes it already holds.
- A bootstrap code's scopes are fixed when it is minted, so `--code` with
  `--scopes` is an error that prints the matching `cliCredentialBootstrap` call.
- `insufficient_scope` errors print both commands with the full scope list (your
  current scopes plus the missing one), so you can copy one and retry.

## Git HTTPS (`setup-git`)

After the server ships persistent `kody_at_…` git auth (see
[auth-setup-git](https://kody.codes/docs/auth-setup-git)), install a credential
helper once:

```bash
kody login   # or: auth bootstrap --code … --lifetime long
kody auth setup-git
git clone https://kody.codes/@owner/name.git
```

`setup-git` uses your `kody login` session (or a scoped API token) to mint a
user-owned `kody_at_…` with `package:read` and `package:write` (default
`--lifetime long`; reuses a suitable stored token). That one credential
authorizes every `@owner/name.git` you can access across all orgs — login
`--org` only scopes the MCP mint session, not git. When an API token is already
stored it probes `org_binding` on `GET /v1/tokens/current`; after a fresh login
with no API token yet, it mints via the login session and checks `org_binding`
on the minted token. Configures a **stable** credential helper (global `kody`
only when that install's version supports `git-credential`, otherwise
`npx -y @kodycodes/cli@<exact-version> …` — never a major-only `@1` range that
can reuse a stale npx cache, and never an ephemeral `~/.npm/_npx/…` path).
Re-running `setup-git` rewrites stale helper entries; every CLI command also
refreshes an outdated pin silently.

```bash
git config --global credential.https://kody.codes.helper '!… git-credential'
git config --global credential.https://kody.codes.useHttpPath true
```

The helper silently remints via your stored `kody login` when the API token is
expired or within an hour of expiry, so you should not need to re-run
`setup-git` for token lifetime. Undo with `kody auth remove-git` (clears git
config helpers, revokes and deletes the stored API token; leaves login alone).
Push moves live HEAD only (packages do not auto-publish). Existing `kody login`
/ `auth bootstrap` flows are unchanged.

## Local package testing (`kody dev`)

Test an unpublished package (app, exports, jobs, webhooks, subscriptions) before
publish. Bundling reuses the same esbuild path as `execute --file` / publish
(`local-bundle.ts`). One shared flag:

| Command              | `--target prod` (default for execute/search) | `--target mock` (default for `kody dev`)          |
| -------------------- | -------------------------------------------- | ------------------------------------------------- |
| `kody dev`           | Local app against real Kody                  | Local app against the CLI mock                    |
| `execute` / `search` | Real capabilities, storage, secrets          | Mock catalog / scratch storage / fake credentials |

The mock is built into the CLI (no kody-celld). It refuses unimplemented routes
with `not_implemented_in_mock` rather than faking success. `--reset-storage`
wipes the mock session's scratch store. Share previews are out of scope;
`execute --local` behavior is unchanged when `--target` is omitted (prod).

```bash
cd ./my-package
kody dev                         # serve kody.app.entry; live reload; --target mock
kody dev fetch /health           # agent-friendly HTTP probe
kody dev job heartbeat           # run a declared job once (never schedules locally)
kody dev webhook ping --body ./fixture.json
kody dev emit demo.event --body ./event.json   # subscription delivery shape
kody dev check                   # bundle + light publish validations

# Four surfaces against mock then prod:
kody execute --target mock --invoke ./greet --params '{"name":"kent"}'
kody execute --target prod --invoke ./greet --params '{"name":"kent"}'
# Published export locally (no --code import wrapper):
kody execute --local --invoke kody:@scope/pkg/export --params '{}'
kody search --target mock local
```

### What `kody dev` does while it runs

- **Rebuilds never drop requests.** A save starts a new workerd, and the proxy
  switches to it only once it is listening. The old one finishes its in-flight
  requests and then stops. Requests that arrive mid-rebuild wait for it, so you
  never get a `503` or the previous bundle after a save.
- **Watching survives editors and scripts.** chokidar watches the package
  (skipping `node_modules`, dotfiles, and `*.map`). A 1s stat poll over the
  files in the current bundle graph backs it up, so replaced files (`sed -i`,
  `cp`, atomic saves) are always picked up.
- **Build errors** print `file:line:col: message` with a code frame. Until the
  next good build, every request gets a `500` error page with the same text
  (HTML for browsers, plain text otherwise, header `x-kody-dev-error: build`).
  The last good build does not keep answering `200`.
- **Runtime errors**: an uncaught throw from the fetch handler returns a
  dev-only `500` page with the stack mapped back to your `.ts` sources
  (`x-kody-dev-error: runtime`). Runtime wrapper and native frames are dropped.
  The terminal prints the same stack.
- **Logs**: app `console.*` output streams to the terminal tagged with the
  request, e.g. `[GET /scores #12] saved 3 rows`. `warn` and `error` go to
  stderr.
- **Live reload** (on by default; `--no-live-reload` turns it off): HTML
  responses get a small `<script>` that listens on `/__kody/dev/events`
  (server-sent events). The page reloads after each swap to a new build. Build
  errors, and runtime errors from the page's own `fetch` calls, show an overlay;
  the page reloads on the next good build. There is no HMR. Only requests that
  accept `text/html` (browser page loads) get the script; compressed HTML, agent
  requests, and `kody dev fetch` responses are left untouched.
- **Fast rebuilds.** File events are debounced for 30ms, and esbuild reuses an
  incremental context, so a save usually serves the new code in about 60ms on a
  small app.
- **Ports.** Each package gets a stable default port in 4100–4999 (derived from
  `kody.id`), so URLs survive restarts. If it is taken, `kody dev` moves to the
  next free port. An explicit `--port <n>` is used exactly and fails with a fix
  when the port is busy (`--port 0` picks any free port). Starting a second
  `kody dev` for the same package and target without `--port` fails and names
  the running server's URL and pid.
- **Client bundle and assets**, same URLs as a published app: `kody.app.client`
  is bundled for the browser and served at
  `<appBasePath>/_assets/client.<hash>.js` (inline source map;
  `client.externals` stay bare imports). `packageContext.clientModuleUrl` points
  at it, and `/_assets/__version.json` reports it. Files in `kody.app.assets`
  are served under `/_assets/`. Both are `no-store` and rebuild on save; editing
  an asset reloads open pages.
- **Prebuild**: `kody.dev.prebuild` runs a shell command from the package root
  before every build (with `KODY_DEV=1`), for generated CSS, icons, or data
  files. Its output is tagged `[prebuild]`. A non-zero exit is shown as a build
  error. File changes made while it runs do not trigger another build.
  `kody.dev.ignore` lists root-relative path prefixes the watcher skips:

  ```json
  {
  	"kody": {
  		"app": {
  			"entry": "./app/router.ts",
  			"client": "./app/client.ts",
  			"assets": "./public"
  		},
  		"dev": {
  			"prebuild": "node scripts/build-css.mjs",
  			"ignore": ["public/generated"]
  		}
  	}
  }
  ```

  `kody.dev` only affects `kody dev`; publish ignores it.

- **Cleanup**: Ctrl-C, `SIGTERM`, and `SIGHUP` stop workerd and remove the
  `kody-dev-*` temp dir. If the CLI is killed outright, a small reaper process
  does the same. Each start also sweeps dirs and orphaned workerd processes left
  behind by dead CLI runs, including older CLI versions.

### Driving `kody dev` from an agent

```bash
kody dev --json --ready-file .kody-dev.json &   # NDJSON events on stdout
curl -s http://127.0.0.1:<port>/__kody/dev/status
kody dev fetch /scores                          # reuses the running server
```

- `--json` prints one JSON object per line on stdout, each with a `type` and an
  ISO `ts`:
  - `ready`: `url`, `port`, `basePath`, `pid`, `statusUrl`, `buildId`
  - `rebuild_start`: `files`
  - `rebuild_ok`: `ms`, `buildId`, `restarted`
  - `build_error`: `file`, `line`, `col`, `message`, `diagnostics`
  - `runtime_error`: `message`, `stack`, `request`
  - `log`: `source`, `level`, `message`, `request`

  Status lines stay on stderr.

- `GET /__kody/dev/status` returns
  `{ ok, state, buildId, url, port, basePath, target, package, pid, lastRebuild, lastError }`.
  `state` is one of `starting`, `building`, `ready`, or `build_error`.
  `lastError` holds the current build error or the most recent runtime error.
- `--ready-file <path>` writes `{ url, port, basePath, pid, statusUrl }` once
  the first build settles, and deletes the file on exit.
- `kody dev fetch` attaches to a running `kody dev` for the same package and
  `--target` (found through the user cache dir and confirmed via the status
  endpoint) instead of booting a second workerd. The request waits for any
  in-progress rebuild, so fetching right after a save sees the new code. Pass
  `--no-attach` to force a one-shot server.

## Local execute

`kody execute --local` runs the same execute module (default export called with
`--params`) on this machine instead of in Kody's cloud sandbox. Local CPU is
free; every `kody:runtime` call (`kody.*`, `kody.mcp.*`, `workflows.create`) is
proxied to Kody's CapabilityProxy and metered like a cloud hop. Static
`kody:@scope/package/export` imports are **resolved into the local workerd
bundle** via `POST /v1/local-execute/package-graph` (same Bearer as
CapabilityProxy — never hosted MCP `execute`, and never a whole-module
CapabilityProxy → `kody.execute` defer). There is no author-facing
`packages.invoke`.

```bash
# Prefer login when already signed in (no temporary API token to paste):
npx @kodycodes/cli login
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'

# Agents on MCP: bootstrap code → store (no tokenCreate, no second OAuth):
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'

# Or a scoped API token (still wins over login / bootstrap store when set):
export KODY_API_TOKEN=…   # minted through the Kody `api` tool
npx @kodycodes/cli execute --local --file ./task.js --params '{"to":"me@example.com"}'

# ADR 0068: pick credentials for credential(key) / credentials(key)
npx @kodycodes/cli execute --local --credential github=work --credential resend=personal:prod \
  --code 'import { credential } from "kody:runtime"; export default async () => (await credential("github")).name'

# Call a published package export without a --code import wrapper:
npx @kodycodes/cli execute --local --invoke kody:@scope/pkg/export --params '{"name":"kent"}'
```

- **Auth:** `--token` / `KODY_API_TOKEN` when set; else stored `auth bootstrap`
  API token; else a valid `kody login` session (OAuth access token as Bearer —
  never printed, never exchanged via `tokenCreate`). Prefer the env var for API
  tokens so they stay out of shell history and `ps`. The bearer stays in the CLI
  process; the sandbox only talks to a loopback bridge. Host MCP OAuth from
  other clients is never read. Until
  [kody-hq/kody#2812](https://github.com/kody-hq/kody/issues/2812) ships,
  login-only Bearer is rejected by the Open API — use bootstrap or a `kody_at_…`
  token in that case.
- **Node.js:** 22 or newer (`package.json` `engines` is `>=22`). Older Node
  fails immediately with that requirement, before workerd is downloaded or
  started.
- **Bundling:** `--file` entries are bundled with esbuild before workerd loads
  `main.js` (relative local imports and bare npm packages from `node_modules`;
  `kody:*` stays external for package-graph / runtime). That matches hosted
  execute and publish. Unresolvable imports fail with a clear bundle error
  before any network call. `--code` and stdin (`--file -`) are left as written
  (no filesystem graph to follow).
- **Runtime:** a pinned [workerd](https://github.com/cloudflare/workerd)
  release, downloaded once from GitHub, sha256-verified, and cached under
  `~/.cache/kody` (Linux, or `$XDG_CACHE_HOME/kody`) or `~/Library/Caches/kody`
  (macOS). Override with `KODY_CACHE_DIR`, or point `KODY_WORKERD_PATH` at your
  own binary. No Docker required. Linux and macOS (x64/arm64) only for now.
- **API:** `https://api.kody.codes` by default (`--api-url` or `KODY_API_URL` to
  override). The CLI calls `POST /v1/local-execute/package-graph` before
  starting workerd (it authenticates the bearer and, when the module imports
  `kody:@…`, downloads stamped package modules for local embedding,
  [platform issue](https://github.com/kody-hq/kody/issues/2808)) and
  `POST /v1/capability-proxy/call` with `{ path, args, conversationId? }` for
  each runtime call. CapabilityProxy requests go through Node's own
  `node:http(s)` client with one keep-alive connection and a 7-minute idle limit
  for headers and body chunks. Origin's 5-minute deadline for a `fetch` with
  `{{secret:…}}` placeholders ends that call first, with its own error. Node's
  default 300-second fetch limit no longer cuts it short. With
  `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, these requests honor `HTTP_PROXY`
  / `HTTPS_PROXY` / `NO_PROXY` like Node's own fetch (Node 22.21 / 24.5 or
  later; older Node fails with a clear error instead of silently bypassing the
  proxy). A PR preview's API host is
  `https://kody-pr-<n>-api.<subdomain>.workers.dev`; the app origin
  (`kody-pr-<n>`) answers `/v1/*` with an HTML 404.
- **Errors:** an expired/revoked token or an account without the `local-execute`
  flag fails fast with a clear message before any code runs. The token is only
  sent over https (plain http is allowed for localhost). A non-JSON error body,
  such as an HTML page from the wrong `--api-url`, is shortened to its title or
  a 200-character excerpt plus its size. Missing package-graph API, unresolved
  imports, or missing artifacts fail clearly — there is **no silent fallback**
  to cloud `kody.execute`.
- **Lifetime:** no execution time limit locally; Ctrl-C (or SIGTERM) stops
  workerd and removes the temporary module.
- **Saved packages:** `import { … } from 'kody:@owner/name/export'` under
  `--local` keeps the user module + package graph in local workerd. Local
  package CPU is not billed as a full cloud execute of the user module; per-call
  CapabilityProxy hops (and whatever the package-graph prep call meters once
  shipped) may still meter. Prefer keeping `--local` in agent workflows — do not
  switch to hosted MCP `execute`. `--invoke` without `--local` is the thin
  passthrough for a single export (still cloud). `packageStorage()`,
  `packageSecrets`, `email`, and `events` stay unbound on the ad hoc entry like
  cloud execute unless the downloaded package modules carry stamps. Outbound
  `fetch` is public-network-only by default. Pass `--allow-private-network` with
  `execute --local` to also allow private and local addresses; the loopback
  bridge used for CapabilityProxy calls remains available either way.

## Token storage

CLI credentials are stored in the OS secret store:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret (not the in-memory kernel keyring)

If the keychain is unavailable (common on headless Linux), the CLI writes a
`0600` file under `$XDG_CONFIG_HOME/kody` (or `%APPDATA%\kody` on Windows,
`~/Library/Application Support/kody` on macOS). Tokens are never printed.

Access tokens refresh automatically on expiry or HTTP 401.

`execute --local` prefers `--token` / `KODY_API_TOKEN` when set; otherwise it
uses stored CLI credentials from `kody login`. Token-only cloud execute still
only reads `--token` / `KODY_API_TOKEN`.

## Benchmark

`npm run build && npm run bench` times the built CLI (startup, `status`, and
`execute --local` against a loopback stand-in for api.kody.codes) over 20 runs
and prints p50/p95. The `bench` workflow runs it on every pull request and
weekly, failing when a scenario's p50 exceeds the budget in
`scripts/bench-budgets.json` (milliseconds over the bare Node startup of the
same run).

## Releases

This repo uses
[semantic-release](https://github.com/semantic-release/semantic-release) the
same way [match-sorter](https://github.com/kentcdodds/match-sorter) does:
conventional commits on `main` publish `@kodycodes/cli` with npm provenance
(`id-token: write`). Version in `package.json` stays
`0.0.0-semantically-released`.

Trusted publishing for `@kodycodes/cli` is attached to this GitHub repository.

## License

MIT © Kent C. Dodds
