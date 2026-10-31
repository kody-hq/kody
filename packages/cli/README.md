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

installs the Kody CLI skill into Claude Code / Cursor / Codex / `.agents`
folders. It prefers the always-current hosted
`/.well-known/agent-skills/kody-cli/SKILL.md` (and refreshes stale local copies
on later CLI runs). That skill tells shell-capable agents to prefer
`execute --local`.

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

Each `kody login` adds an org (chosen in the browser, or via `--org`). If you do
not have an account yet, create one on that page; login resumes the same
authorization after signup and email verification. Re-logging into an org that
is already stored replaces only that org's credential. Org-scoped commands
(`execute`, `search`, `whoami`, `api`, …) take `--org <slug>` or `KODY_ORG`
(flag wins, then env, then the active org). `kody logout` removes the active
org; `kody logout --org <slug>` removes one org. Git auth stays user-wide
(`kody auth setup-git` once covers every repo across orgs). Existing single-org
keychain credentials migrate silently into the multi-org store as the active org
(no re-login).

## Remote or headless machines

`kody login` opens a browser and waits for it on `http://127.0.0.1:43742`, so
the browser has to run on the same machine as the CLI. On a remote VM, a NAS, or
over SSH, use the device flow instead:

```bash
kody login --device              # prints a URL and a code; approve on any device
kody login --device --org acme   # same, bound to the acme org
```

The CLI prints `https://kody.codes/device` and an 8-letter code such as
`BCDF-GHJK`, plus a link that fills the code in for you. Open either one on your
phone or laptop, sign in, check that the code matches, and choose **Approve**.
The CLI polls in the background and stores the same device API token
`kody login` stores. Codes expire after 10 minutes. Only approve a code you
started yourself on a device you control.

`kody login` suggests `--device` when it detects an SSH session or no display,
when it cannot open a browser, or when the callback port is busy. The browser
flow stays the default.

## Commands

| Command                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kody install`                                    | Detect running local MCP clients and write their remote MCP config. The host client starts OAuth when the user connects. **Recommended long-term path.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kody skill install`                              | Installs the hosted `kody-cli` skill (or the bundled stub offline) into Claude Code / Cursor / Codex / `.agents`. Later CLI runs refresh stale copies by digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `kody login`                                      | Browser OAuth (CIMD + PKCE) for the CLI itself. Adds/replaces one org login (browser picker, or `kody login --org acme`) and keeps other org logins. `--device` signs in from another device instead ([Remote or headless machines](#remote-or-headless-machines)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `kody org list`                                   | Lists logged-in orgs and marks the active one. `--json` for agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `kody org use [<slug>]`                           | Switches the active org. With a slug (agents) switches directly; with no slug on a TTY opens a chooser; without a TTY pass a slug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kody logout`                                     | Removes the active org login (or `--org <slug>` for one org) and clears a stored bootstrap/API token when appropriate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `kody status`                                     | Shows CLI login / stored API token state without printing secrets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `kody auth bootstrap --code`                      | Redeems a one-shot `kody_bc_…` from MCP `cliCredentialBootstrap` and stores the resulting `kody_at_…` for `execute --local` (never prints the token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kody auth bootstrap --scopes`                    | Replaces the default bootstrap scope list (include every scope you need): mints the code itself by passing `scopes` to `cliCredentialBootstrap` (with `--token`, else the `kody login` session, else a stored token), then redeems and stores it. See [Opt-in scopes](#opt-in-scopes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `kody auth setup-git`                             | Installs a Git credential helper for `https://kody.codes/@owner/name.git` (persistent `kody_at_…`, user-owned token with `package:read`/`package:write`). See [Git HTTPS](#git-https-setup-git).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `kody auth remove-git`                            | Inverse of `setup-git`: clears Kody HTTPS git helpers, revokes the stored API token, deletes it from the keychain. Leaves `kody login` alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `kody git-credential`                             | Credential helper invoked by Git after `setup-git` (`get` / `store` / `erase`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kody whoami`                                     | Shows the credential commands will use (`--token`, `KODY_API_TOKEN`, stored API token, or `kody login`), its token id and scopes, and any other stored credential it outranks. See [Which credential a command uses](#which-credential-a-command-uses).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kody search [query]`                             | Calls Kody `search` from the CLI (prefer the host MCP tool). Token-only auth uses Open API `GET /v1/search`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kody api <operationId>`                          | Thin Open API wrapper matching the MCP `api` tool: `operationId` + flat `--params` JSON. Auth: `--token`, `KODY_API_TOKEN`, the stored API token, then `kody login` (same credential `kody whoami` reports). The parsed `/openapi.json` route map is cached under the Kody cache dir keyed by the document's `ETag` and revalidated with `If-None-Match` on each run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `kody package publish`                            | Thin wrapper for `packagePublishExternalPush`. Optional positional `@owner/leaf`, bare leaf name, or package UUID (names are resolved to the package UUID via `packageList`); extra fields via `--params`. Same auth as `kody api`. Prints the API JSON. Exit **0** for `published`, `already_published` (including `artifacts_rebuilt: true`), and `dispatched` (poll `workflowRunList({ workflow_id })`). Exit **1** for refusal/rejection statuses (`checks_failed`, `locked`, `approval_required`, `not_fast_forward`) with the API `message` (or a checks summary) on stderr, like npm. Auth / permission / network failures also exit 1; `--json` adds `{ error, message, sent }` on stdout for network errors (`sent: false` = not sent; `sent: "unknown"` = maybe sent — prefer `kody api workflowRunList` with `workflow_id` when known, otherwise a recent list, before retry). Re-publishing the same commit is safe (durable dedupe / `already_published`). |
| `kody package collaborators` / `grant` / `revoke` | Who can use one package, and add or remove teams and members of the org (`--org`). `<package>` is `@owner/leaf`, the name leaf, or the package id. `grant <package> --team <slug>\|--user <username> [--preset read\|use\|contribute\|manage]` (default `use`) adds or changes a collaborator via `packageCollaboratorSet`; `--preset read` shares source only (read, clone, and fork — no execute). People outside the org are refused. `revoke <package> --team\|--user\|--grant <grant_id>` removes one via `packageCollaboratorRemove`. Needs Manage on the package and a token with `package:manage_access` (`auth bootstrap --scopes …,package:manage_access`). Prints a summary, or JSON with `--json`.                                                                                                                                                                                                                                                          |
| `kody execute`                                    | Calls Kody `execute` from the CLI (`--invoke`, `--code`, `--file`, or stdin via `--file -`). `--invoke` is client-side sugar: the CLI writes the one-export import passthrough and sends it as `code`, the only module field hosted execute accepts. With a scoped API token and no login (or with `--token`), cloud execute goes through CapabilityProxy → `kody.execute` — no `kody login`. Add `--local` to run the module (and static `kody:@…` package modules) on this machine instead. `--credential key=name` (repeatable; `org:name` / `personal:name` / empty `=` for none) picks ADR 0068 credentials for `--local` or a `kody login` MCP session. `--allow-private-network` opts local execution into private and local network access. `--target prod\|mock` (default `prod`) sends CapabilityProxy / search hops to prod or the built-in CLI mock; `--target mock` implies local workerd.                                                                 |
| `kody dev`                                        | Local testing for unpublished packages. Serves `kody.app.entry` on localhost via workerd with hot reload. Subcommands: `fetch`, `job`, `webhook`, `emit`, `check`. Default `--target mock` (scratch storage, fake credentials). Covers exports, webhooks, schedules (run-once), and subscriptions. See [Local package testing](#local-package-testing-kody-dev).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`--json` prints structured MCP results. On command failures it also prints a
JSON error object on stdout (`error`, `message`, and when a network hop failed
before an HTTP response, additive `sent: false | "unknown"`).

## Token-authenticated execute (no `kody login`)

Agents already on Kody MCP should prefer `cliCredentialBootstrap` →
`kody auth bootstrap --code …` (ADR 0056) so a one-shot `kody_bc_…` seeds the
CLI store without pasting `kody_at_…` into chat. Interactive humans can use
`kody login`. Scoped API tokens (`kody_at_…`, from bootstrap redeem,
`tokenCreate`, or `POST /v1/tokens`) authenticate the Open API and
CapabilityProxy. They never replace MCP OAuth on `/mcp`. See
[Which credential a command uses](#which-credential-a-command-uses) for the
order the CLI picks them in:

```bash
# Preferred for agents on MCP (no tokenCreate, no second OAuth):
# 1. MCP api tool, operationId cliCredentialBootstrap → { bootstrap_code, cli_command }
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
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

- Neither bootstrap store, `kody login`, nor a token → one shared
  not-authenticated error: agents on MCP call `cliCredentialBootstrap` and run
  the returned `cli_command` (never ask a human to paste a token); humans run
  `kody login`; CI/headless uses `tokenCreate` + `KODY_API_TOKEN`.
- For `execute --local` specifically: `--token` / `KODY_API_TOKEN` wins when
  set; else a stored bootstrap/API token from `auth bootstrap`; else the stored
  `kody login` OAuth access token as Bearer only when the API and MCP URLs are
  paired (no under-the-hood `tokenCreate`). The default pair is
  `https://api.kody.codes` and `https://kody.codes/mcp`; preview workers pair
  when the API worker name adds `-api`, and loopback hosts pair at any port. For
  a different API origin, use `auth bootstrap --api-url <origin>` or set
  `KODY_API_TOKEN`. Paired `kody login` OAuth is accepted as Bearer on
  CapabilityProxy and package-graph. Unpaired API origins need bootstrap or a
  scoped `kody_at_…` token.
- Wrong/expired token → 401 with the same agent-first not-authenticated guidance
  (or the OAuth platform-gap message when the bearer is login OAuth).
- Wrong scopes → the error names the missing scope and the exact command to mint
  a token that adds it (see [Opt-in scopes](#opt-in-scopes)). When your org role
  lacks the permission, it says so instead: a new token cannot add it, and an
  org Owner has to grant it.
- Account flag off → the error includes `feature_disabled` and the
  `local-execute` feature flag. Another token does not bypass that flag.
- Prefer the env var so the token stays out of shell history and `ps`.
- Never scavenge host MCP OAuth tokens from disk (ADR 0053).

## Which credential a command uses

One resolver picks the credential for every command, and `kody whoami` reports
the same pick:

| Commands                                                                  | Order                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `whoami`, `api`, `package`, `execute --local`, `context`, `daemon`, `dev` | `--token`, `KODY_API_TOKEN`, stored API token, `kody login`            |
| `search`, cloud `execute` (no `--local`)                                  | `--token`, `kody login` (over MCP), `KODY_API_TOKEN`, stored API token |
| `auth bootstrap --scopes` (minting)                                       | `--token`, `kody login`, `KODY_API_TOKEN`, stored API token            |

Desktop integrations can set `KODY_CREDENTIAL_SOURCE=login` to select only the
browser login for these commands. There is no API token fallback in this mode,
and saved API tokens remain unchanged. Unset it for normal CLI precedence.

- The stored API token comes from `kody auth bootstrap` or
  `kody auth setup-git`. `kody login` stores a login session next to it and does
  not replace it, so a stored token keeps winning for `api` and the other
  first-row commands after you log in again. `kody login` prints a note when
  that happens.
- To change the stored token's scopes, run
  `npx @kodycodes/cli auth bootstrap --lifetime short --scopes <every scope you need>`
  (mints with your login and replaces the stored token). `kody logout` clears
  both.
- `kody whoami` prints `credential:` (which one is in use, with its token id),
  its `scopes:`, and `also stored:` lines for credentials it outranks. With
  `--json` the same data is under `credential` and `otherCredentials`.
- `insufficient_scope` errors end with `Credential used: …` and, for a stored
  token, the exact `auth bootstrap` command that replaces it.

## Opt-in scopes

Bootstrap tokens default to local-execute use scopes plus `package:write`,
`package:create`, and `token:delete`. They do not include `search:read`. Pass
`--scopes` when a task needs a different set (the list replaces the defaults):

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
kody dev check                   # local bundles + snapshot membership + publish checks (needs login)
kody dev check --offline         # local bundles + snapshot membership only; publish can still refuse
kody dev check --debug           # also print the publish checks call: HTTP status, error code, request id

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
  before every `kody dev` serve rebuild (with `KODY_DEV=1`), for generated CSS,
  icons, or data files. It does **not** run for `kody dev check` or publish.
  Publish builds the pushed git snapshot, so generated files that exports import
  must be committed (or produced somewhere publish can see). Prebuild output is
  tagged `[prebuild]`. A non-zero exit is shown as a build error. File changes
  made while it runs do not trigger another build. `kody.dev.ignore` lists
  root-relative path prefixes the watcher skips:

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

  `kody.dev` only affects `kody dev` serve; publish ignores it.

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
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
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
  other clients is never read. Paired `kody login` OAuth is accepted as Bearer
  on CapabilityProxy and package-graph. Unpaired API origins need bootstrap or a
  `kody_at_…` token.
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
  `{{secret:…}}` placeholders ends that call first, with its own error. The
  client idle timeout is 7 minutes, so Node's default 300-second fetch limit
  does not apply. With `NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, these
  requests honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` like Node's own fetch
  (Node 22.21 / 24.5 or later; older Node fails with a clear error instead of
  silently bypassing the proxy). A PR preview's API host is
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
  switch to hosted MCP `execute`. `--invoke` without `--local` sends the same
  CLI-written passthrough to the cloud as `code`. `packageStorage()`,
  `packageSecrets`, `email`, and `events` stay unbound on the ad hoc entry like
  cloud execute unless the downloaded package modules carry stamps. Outbound
  `fetch` is public-network-only by default. Pass `--allow-private-network` with
  `execute --local` to also allow private and local addresses; the loopback
  bridge used for CapabilityProxy calls remains available either way. A refused
  `fetch` throws a plain `TypeError` that names the setting, the blocked host,
  and how to change it (for example
  `Blocked by kody execute --local's network setting: the request to 10.0.0.1 was refused because this context allows public internet only … Re-run with --allow-private-network …`).
  Execution context daemon runs apply the context grant's `egress` the same way
  (`public`, `public-and-lan`, `allowlist` hosts and ports, or `none`), and the
  message points the machine owner at `executionContextUpdate` `grant.egress`.

## Execution context host folders

Runs on an execution context (`kody daemon`) use workerd's virtual filesystem
unless a host folder is allowed by **both** layers:

1. The context's server grant (`grant.fs`, set with `executionContextUpdate` by
   someone with Contribute on the context).
2. This machine's local policy, kept by the machine owner in
   `execution-context-policy.json` under the CLI config directory
   (`~/.config/kody/` on Linux or `$XDG_CONFIG_HOME/kody/`,
   `~/Library/Application Support/kody/` on macOS, `%APPDATA%\kody\` on
   Windows). No file means no host folder access.

```sh
kody context policy                              # show allowed folders
kody context policy allow ~/Desktop --mode rw    # ro (default) or rw
kody context policy remove ~/Desktop
```

The daemon mounts the overlap of the two layers at its real absolute path, with
the narrower mode (`ro` wins), and re-applies it on every `grant.update` and
policy edit (running daemons pick up edits within a few seconds). Paths are
canonicalized with `realpath`, so symlinks, `..` segments, and prefix tricks
like `/Users/a/Desktop-evil` cannot reach outside a mount. A context advertises
the `fs` capability only while at least one folder is mounted, so
`requires: ["fs"]` routing and chains skip it otherwise (`no_fs`: the server
grant lists no folders; `no_local_fs`: the local policy allows none of them).

Inside a run, `node:fs` / `fs/promises` `readFile`, `writeFile`, `appendFile`,
`readdir`, `stat`, `lstat`, `mkdir`, `rm`, `unlink`, `rmdir`, `rename`,
`copyFile`, `access`, and `realpath` work on mounted paths (up to 32 MiB per
read or write). Writes under an `ro` mount fail with `EROFS`; paths outside
every mount fail with `EACCES` naming the layer that refused (server grant or
local policy). Synchronous calls and streams cannot reach host folders. Other
paths, including workerd's `/bundle`, `/tmp`, and `/dev`, stay virtual.

## Token storage

CLI credentials are stored in the OS secret store:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service / libsecret (not the in-memory kernel keyring)

If the keychain is unavailable (common on headless Linux), the CLI writes a
`0600` file under `$XDG_CONFIG_HOME/kody` (or `%APPDATA%\kody` on Windows,
`~/Library/Application Support/kody` on macOS). Tokens are never printed.

`kody login` checks that this folder exists and is writable (creating it when
missing) before it opens the browser. If the folder is blocked, login stops
early and prints the folder path plus the commands to fix it. The sign-in link
is always printed too, so you can paste it into a browser if no window appears.

Access tokens refresh automatically on expiry or HTTP 401.

`execute --local` prefers `--token` / `KODY_API_TOKEN` when set, then a stored
API token, then the `kody login` session. See
[Which credential a command uses](#which-credential-a-command-uses).

## Execution context daemon performance

`kody daemon` runs up to 2 context runs at once by default. Change it with
`kody daemon --max-concurrent <n>` or `KODY_CONTEXT_MAX_CONCURRENT` (1 to 8).
The context's grant `limits.maxConcurrent` can only lower it. Each run still
gets its own workerd process and temp dir, so runs share no globals or virtual
files. Granted host folders are the real folders, so concurrent runs with the
same `rw` folder can write the same host files. The daemon caches package graphs
(32 entries, 60 seconds, per requester, org, conversation and module source) so
repeat runs skip that API round trip. Code that imports saved packages
(`kody:@…`) is never cached, so package access is re-checked on every run.

Every context run reports where its time went in
`structuredContent.ranOn.timing` on `execute`: `queueMs`, `setupMs` (including
`packageGraphMs` and `packageGraphCached`), `executeMs` and `daemonMs` on the
machine, plus `serverMs` and `transitMs` (dispatch and return on the wire)
measured by Kody.

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
(`id-token: write`). A squash-merge subject that omits a conventional prefix
still publishes a patch when the merge touches `packages/cli`. Version in
`package.json` stays `0.0.0-semantically-released`.

Trusted publishing for `@kodycodes/cli` is attached to this GitHub repository.

## License

MIT © Kent C. Dodds
