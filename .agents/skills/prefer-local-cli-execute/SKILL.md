---
name: prefer-local-cli-execute
description: >
  Prefer @kodycodes/cli execute --local over hosted MCP execute for one-off
  modules and smoke tests when Node ≥22 and the CLI are available. Agents
  already on Kody MCP: cliCredentialBootstrap then CLI auth bootstrap (no second
  OAuth, no tokenCreate). Interactive humans: kody login. Scoped KODY_API_TOKEN
  remains for CI/headless. Use when running Kody execute from Cursor (including
  Cloud Agents), bootstrapping CLI credentials, or choosing local CLI vs Open
  API / MCP `api`.
---

# Prefer local CLI execute

When Node is 22 or newer and `@kodycodes/cli` is available, run one-off modules
with local execute. Do not use hosted MCP `execute`. This skill and
[Local CLI execute](https://kody.codes/docs/local-execute)
(`guide:local_execute`,
[docs/guides/local-execute.md](../../../docs/guides/local-execute.md)) are the
source of truth. In this repo, `npm install` runs `packages/cli` `prepare` so
`npx @kodycodes/cli` resolves the workspace `dist/bin.js` without a manual CLI
build. Open API fallback: [Open API](https://kody.codes/docs/open-api)
(`guide:open_api`).

Local CPU is not counted as `execute` or `dynamic_worker_day`. Capabilities
called through the proxy still meter normally. Prefer `KODY_API_TOKEN` in the
environment over `--token` so the secret is not visible in process arguments.

## Command

Agents already on MCP: call `cliCredentialBootstrap` with a required lifetime
(single-task agents use `short`), then run the returned `cli_command` (it
already includes lifetime flags). Humans who can finish browser OAuth:
`npx @kodycodes/cli login` once. CI with no MCP session and no interactive
login: set `KODY_API_TOKEN` in the environment. Never paste a `kody_at_…` into
chat.

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": { "lifetime": "short" }
}
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Saved packages keep `--local` and a static `kody:@…` import.

## Failure

- Node is below 22, the CLI is missing, or the host cannot run workerd. Use Open
  API / MCP `api`, or fix the environment. Hosted MCP `execute` stays banned.
- Lifetime is missing. Pass `lifetime: "short"|"long"` (or both idle/max
  seconds) to `cliCredentialBootstrap`, and `--lifetime short|long` (or both
  `--idle-ttl-seconds` / `--max-lifetime-seconds`) to `auth bootstrap`.
- The bootstrap code is rejected. Call `cliCredentialBootstrap` again with
  `lifetime: "short"`. Do not switch to `kody login` or `tokenCreate` while an
  MCP session exists.
- `search` is forbidden. Default bootstrap scopes are local-execute use scopes
  (`org:execute`, `org:read`, package/integration/secret/email/job/app/memory
  use scopes), plus `package:write`, `package:create`, and `token:delete` — not
  `search:read`
  ([ADR 0056](../../../docs/contributing/decisions/0056-cli-credential-bootstrap.md)).
  `whoami` works. Use MCP `search`, or a token with `search:read`. Bootstrap
  tokens that omit `package:create` cannot call `packageGetGitRemote` with
  `create: true`; run `cliCredentialBootstrap` again.
- The module imports `kody:@…`. Keep `--local`. Default bootstrap includes
  `package:execute` and `integration:read` so package-graph and
  `createAuthenticatedFetch` work for saved packages.
- The CLI asks for a login, a bootstrap, or a token. Priority is `--token` /
  `KODY_API_TOKEN`, then the stored bootstrap token, then `kody login`.
