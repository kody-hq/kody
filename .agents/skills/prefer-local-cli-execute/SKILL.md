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

Agents already on MCP: call `cliCredentialBootstrap`, then run the returned
`cli_command`. It saves the same credential `kody login` saves (login scopes
capped by your MCP session and org role, 14d idle / 3mo max) in the same slot.
Humans who can finish browser OAuth: `npx @kodycodes/cli login` once. CI with no
MCP session and no interactive login: set `KODY_API_TOKEN` in the environment.
Never paste a `kody_at_…` into chat.

```json
{
	"operationId": "cliCredentialBootstrap",
	"params": {}
}
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…'
npx @kodycodes/cli execute --local --code 'import { kody } from "kody:runtime"; export default async function main() { return await kody.metaGetCurrentUser({}) }'
```

Saved packages keep `--local` and a static `kody:@…` import.

Omit `scopes`: the default is the login-equivalent set. Passed `scopes` replace
it with a deliberately narrower list, which often misses `integration:use`,
`org:execute`, or `secret:use` and fails with `insufficient_scope`.

## Failure

The CLI errors name the fix for a rejected bootstrap code and
`insufficient_scope` (see
[ADR 0056](../../../docs/contributing/decisions/0056-cli-credential-bootstrap.md)).
Follow the message. Judgment calls the CLI cannot make:

- Node is below 22, the CLI is missing, or the host cannot run workerd. Use Open
  API / MCP `api`, or fix the environment. Hosted MCP `execute` stays banned.
- While an MCP session exists, remint with `cliCredentialBootstrap` instead of
  switching to `kody login` or `tokenCreate`.
- Credential priority is `--token` / `KODY_API_TOKEN`, then the one saved CLI
  credential (`kody login` or `auth bootstrap`, whichever ran last). Git and
  `kody auth setup-git` use the same credential and never mint their own.
