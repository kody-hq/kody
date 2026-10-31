---
id: open_api
title: Kody Open API
summary:
  Call Kody over HTTPS at api.kody.codes. MCP api runs one operation
  (operationId + params), including tokenCreate / tokenList / tokenRevoke.
  Available to every signed-in account.
category: platform
---

# Kody Open API

The Kody Open API and MCP `api` tool are available to every signed-in account.
Call Kody over HTTPS at [api.kody.codes](https://api.kody.codes)
(`/openapi.json` and `/v1/*`). Interactive docs:
[api-docs.kody.codes](https://api-docs.kody.codes).

## What it is

- **Kody Open API** — JSON HTTP at [api.kody.codes](https://api.kody.codes)
  (`/openapi.json` and `/v1/*`).
- **MCP `api` tool** — run one Open API operation (`operationId` + `params`)
  from a connected agent. Use it to mint, list, and revoke scoped API tokens
  (`tokenCreate` / `tokenList` / `tokenRevoke`). There is no account UI for
  tokens.

For CLI `--local` setup and usage (CapabilityProxy / package-graph), see
[Local CLI execute](./local-execute.md) (`guide:local_execute`). That path is
separate from Open API; some `/v1` routes exist so the CLI can hop to origin.

## Mint a scoped API token

With MCP `api` available, mint a token (value returned once). Lifetime is
required: `short` (1h idle / 24h max), `long` (14d idle / 3mo max), or both
`idle_ttl_seconds` and `max_lifetime_seconds`. Tokens default to
`org_binding: "org"` (fixed to the current request org). Pass
`"org_binding": "user"` for a person-owned token that selects an org per request
with `?org=<slug>` (see [Git credential helper](./auth-setup-git.md)).

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "ci-bot",
		"scopes": ["org:read", "search:read"],
		"lifetime": "short"
	}
}
```

Include `"org:execute"` in `scopes` only when a headless CLI needs
CapabilityProxy / package-graph over a `kody_at_…` token (see
[Local CLI execute](./local-execute.md)). Put the value in the environment
(`KODY_API_TOKEN`); never paste it into chat.

List and revoke with `tokenList` / `tokenRevoke`, or the same operations over
HTTP. Step by step, plus the CLI fallback: [API tokens](./api-tokens.md)
(`guide:api_tokens`).

## Metering

Each Open API operation (HTTPS, MCP `api`, CapabilityProxy hop, or package-graph
prep) meters as an observe-only `api_call`. Capability work behind the operation
still meters as usual.

## Where to go next

- [api-docs.kody.codes](https://api-docs.kody.codes) — interactive OpenAPI
- [API versioning and deprecation](./api-versioning.md) — `/v1` policy, windows,
  `Retry-After` on `429`
- [Local CLI execute](./local-execute.md) — `@kodycodes/cli execute --local`
- [Runtime and efficiency](./platform-efficiency.md) — how cloud execute meters
  worker days
- Contributor detail:
  [Open API architecture](../contributing/architecture/open-api.md)
