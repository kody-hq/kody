---
id: local_execute
title: Local CLI execute
summary:
  Prefer @kodycodes/cli execute --local when Node ≥22 and the CLI are available.
  Orthogonal to Open API: use this guide for CLI setup and --local usage; see
  guide:open_api for HTTPS / MCP api fallback.
category: platform
---

# Local CLI execute

When **Node ≥22** and `@kodycodes/cli` are available, prefer
`npx @kodycodes/cli execute --local` for one-off modules, smoke tests, and
composition. Local execute is **orthogonal** to Open API: the CLI runs your
module in a local workerd and forwards each `kody:runtime` call through the
CapabilityProxy. Do **not** use hosted MCP `execute` for agent work when a local
or Open API path exists.

Auth: `--token` / `KODY_API_TOKEN` (`kody_at_…` with `org:execute`; add
`package:execute` when the module imports `kody:@…`), or when no API token is
set, the access token from `kody login` (MCP OAuth) as Bearer on CapabilityProxy
and package-graph routes.

## Setup

**Agents already on MCP (do this yourself; never ask a human for a token):**
call `cliCredentialBootstrap` with a required lifetime (single-task agents use
`short`). Prefer MCP `execute` with
`kody.cliCredentialBootstrap({ lifetime: "short" })`, or MCP `api` with
`operationId: "cliCredentialBootstrap"`. It returns a one-shot `kody_bc_…` code
and a `cli_command` that already includes lifetime flags (**not** a
`kody_at_…`). Bootstrap tokens are person-owned (`org_binding: user`); pass
`?org=<slug>` on API calls to act in a team org (default: personal). Run the
returned `cli_command` (no second OAuth, no `tokenCreate`):

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": { "lifetime": "short" }
}
```

```bash
# Or run the cli_command returned by cliCredentialBootstrap:
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
```

`short` is 1 hour idle / 24 hours max. `long` is 14 days idle / 3 months max. Or
pass both `--idle-ttl-seconds` and `--max-lifetime-seconds`. Lifetime is
required; missing it fails with the exact flag syntax.

**Default scopes:** bootstrap tokens include local-execute use scopes
(`org:execute`, `org:read`, and package/integration/secret/email/job/app/memory
use scopes), plus `package:write` (plain-repo / package pushes) and
`token:delete` (self-revoke). They do not include `search:read`. When a task
needs a different set, pass `scopes` when minting. The list replaces the
defaults, so include every scope you need:

```bash
# Agents on MCP: cliCredentialBootstrap({ lifetime: "short", scopes: ["org:execute", "org:read", "package:execute", "package:read", "package:write"] })
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short

# After `kody login`, the CLI mints the code itself and stores the token:
npx @kodycodes/cli auth bootstrap --lifetime short \
  --scopes org:execute,org:read,package:execute,package:read,package:write
```

`--scopes` mints with `--token` when given, else the `kody login` session (any
scope your org role grants), else `KODY_API_TOKEN` or the stored token (only
scopes that token already holds). `--code` with `--scopes` is an error because a
code's scopes are fixed when it is minted.

**Interactive humans:** `kody login` once per machine (beside the agent
`cliCredentialBootstrap` path above), then run `--local` without
`KODY_API_TOKEN`.

```bash
npx @kodycodes/cli login   # once
```

**CI / headless only:** scoped `KODY_API_TOKEN` (`kody_at_…` with `org:execute`,
plus `package:execute` for saved-package imports), usually from MCP `api`
`tokenCreate` with a required lifetime. Put the value in the environment; never
paste it into chat (agents on MCP must use `cliCredentialBootstrap` instead).
Prefer the env var over `--token`. When set, `KODY_API_TOKEN` wins over
`kody login` / bootstrap store. Minting details: [Open API](./open-api.md)
(`guide:open_api`).

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "kody-cli-local",
		"scopes": [
			"org:execute",
			"org:read",
			"package:execute",
			"package:read",
			"integration:read",
			"integration:use",
			"secret:use"
		],
		"lifetime": "short"
	}
}
```

```bash
export KODY_API_TOKEN='kody_at_…'
```

## Usage

```bash
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Use `--file path.ts` the same way when the module lives on disk. Keep `--local`;
static `kody:@owner/name` imports still run locally (package-graph download +
CapabilityProxy hops). The CLI posts the `kody:@` imports that still need
published modules to `POST /v1/local-execute/package-graph` (with a tiny
synthetic entry), never the whole module. Inline `code` on that route may be up
to just under the Open API JSON body limit (~5 MiB); larger callers pass
`imports` alone so origin synthesizes a tiny entry. If inline `code` still
exceeds that ceiling, the API (and CLI) name the actual UTF-8 byte length and
the maximum — not a bare `Invalid parameters.` Package-graph always returns the
gateway-fetch shim, so ad-hoc scripts with no `kody:@` imports still expand
`{{secret:…}}` placeholders on origin (or fail closed naming the secret) instead
of sending them raw. `import { credential } from 'kody:runtime'` for ad hoc and
unpublished package source needs a CLI whose host `kody:runtime` exports
`credential` / `credentials` per the
[CLI local credential runtime](../contributing/contracts/cli-local-credential-runtime.md)
contract (CapabilityProxy opens a handle; gateway placement only — same as
hosted). Older CLIs fail at import time; upgrade `@kodycodes/cli`.

A `fetch` that carries a placeholder runs on origin with the same 5-minute
overall deadline as cloud fetches. The deadline starts when origin sends the
request upstream, after it checks your quota and fills placeholders, and runs
until the response body ends. The response is also aborted after 60s with no
bytes. `--local` has no run cap, so a long streamed response, such as an AI
completion, can finish.

Small buffered placeholder-bearing bodies use the JSON CapabilityProxy hop
(`kody.gatewayFetch`): origin buffers the whole response before returning it, so
your code receives nothing until the body ends, and a body over 4 MiB fails.
Streamed bodies, multipart bodies, and bodies that would exceed 4 MiB use the
streaming hop (`POST /v1/capability-proxy/gateway-fetch` via
`kody.gatewayFetchStream`): there is no 4 MiB hop cap. That path still respects
the Cloudflare Worker upload limit (~100 MiB on Free/Pro). A `Content-Length`
over that limit returns JSON `413 payload_too_large`. See the
[CLI streaming gateway-fetch contract](../contributing/contracts/cli-streaming-gateway-fetch.md).

From `@kodycodes/cli` 1.13.1, the CLI's CapabilityProxy client waits up to 7
minutes for origin's reply, so the gateway's 5-minute deadline is what ends a
slow fetch, with its own error. Older CLIs stop waiting after Node's default 300
seconds (`UND_ERR_HEADERS_TIMEOUT`) and need a few seconds of margin. With
`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, these requests still go through
`HTTP_PROXY` / `HTTPS_PROXY`. A `fetch` without placeholders, and a multipart
upload that does not need fill, goes straight from local workerd and is not
subject to this deadline.

## Running from a package checkout

Run `--file` from inside a package directory and the CLI resolves that package's
own `kody:@…` exports (and `.kody/deps.json` mappings) from the working tree.
Their remaining `kody:@` dependencies come from published package-graph. When a
**successful** package-graph response omits required modules, the module never
ran: that error (`incomplete_package_graph` in `--json` output) is a package
resolution problem, not an auth problem. HTTP 401 or 403 from package-graph is
still auth or permission — use the Failure section below. Two workarounds for
`incomplete_package_graph`:

- Inside the checkout, import your own package's files with relative imports
  (`./src/helper.ts`) instead of `kody:@scope/pkg/helper`.
- To test the **published** exports, run the entry from a directory outside the
  checkout so every `kody:@` import resolves from package-graph.

## Failure

- Node is below 22, the CLI is missing, or the host cannot run workerd. Use
  [Open API](./open-api.md) / MCP `api`, or fix the environment. Hosted MCP
  `execute` stays banned for that failure case.
- Not authenticated (missing or invalid credentials). Agents on MCP: call
  `cliCredentialBootstrap` and run the returned `cli_command`; never ask a human
  to paste a token. Humans: `kody login`. CI/headless: `tokenCreate` +
  `KODY_API_TOKEN`.
- Bootstrap or redeem rejects a missing lifetime. Pass `--lifetime short|long`
  (or both idle/max flags). Call `cliCredentialBootstrap` again with
  `lifetime: "short"` if the code expired.
- `insufficient_scope` on a token means it lacks a scope. The error names the
  scope and prints both mint commands with the full list (the token's scopes
  plus the missing one); run one and retry. `--token` and `KODY_API_TOKEN` still
  win over the stored token, so replace or unset them before retrying. Open API
  errors carry the same list as `details.mint_scopes`. When your org role lacks
  the permission (`denial: missing_permission`), a new token cannot help; an org
  Owner has to grant it.
- **Package-scoped `secretSet` / `secretSetMany` / `secretDelete` are not
  available under `--local`.** Local CapabilityProxy does not attach package
  secret authority (a client-supplied package id is not trusted as a hosted
  run). Use hosted package execute, or set the secret from the account UI
  (`/connect/secret-set`) or Open API `secretSet` with a user scope / outside
  local execute. See [Secrets](./secrets.md#scopes).
- The module imports `kody:@…`. Keep `--local`.
- Auth priority for `--local`: `--token` / `KODY_API_TOKEN`, then the stored
  bootstrap token, then `kody login`.
