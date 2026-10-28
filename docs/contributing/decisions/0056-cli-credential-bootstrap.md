# 0056: Explicit MCP/API session → CLI credential bootstrap

- **Status:** accepted
- **Date:** 2026-10-01
- **Amended:** 2026-10-06 (required lifetimes, active-token cap 500, reclaim);
  2026-10-09 (Teams P4: default eventual scopes are `org:execute` + `org:read`);
  2026-10-09 (default scopes also include `package:execute` so local `kody:@…`
  package-graph resolution works); 2026-10-09 (default scopes restore pre-P4
  `local-execute` parity: integration, secret, email, job, app, memory use-level
  permissions — migration 0092); 2026-10-12 (default scopes also include
  `package:write` and `token:delete` so new CLI bootstrap tokens can push plain
  repos and self-revoke without a second mint; existing tokens unchanged);
  2026-10-25 (default scopes also include `package:create` so
  `packageGetGitRemote` with `create: true` works from CLI bootstrap tokens;
  existing tokens unchanged); 2026-10-27 (minting is callable from the MCP `api`
  tool and Open API only; `execute` code, hosted or `--local`, is refused);
  2026-10-28 (the official CLI may use the OAuth device grant,
  [0082](./0082-cli-oauth-device-authorization-grant.md))
- **Amends:** [0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md),
  [0055](./0055-cli-mcp-oauth-local-execute-http.md)

## Context

[0055](./0055-cli-mcp-oauth-local-execute-http.md) lets interactive `kody login`
MCP OAuth authenticate CapabilityProxy and package-graph. Agents already
connected to Kody over MCP still faced a second interactive OAuth (or a
`tokenCreate` that returns `kody_at_…` into chat-facing tool text) before
`npx @kodycodes/cli execute --local` worked without `KODY_API_TOKEN`.

[0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md) forbids scavenging
**host** MCP OAuth into the CLI. The missing piece is an **explicit**
session→CLI handoff that does not paste long-lived secrets into chat.

Cloud Agent fleets then filled the old 50-token cap with same-day
`kody-cli-bootstrap` tokens because every fresh VM minted a long-lived bootstrap
credential and idle TTL did not help inside one day (#2966).

## Decision

One credential-bootstrap primitive, dual-exposed:

1. **Capability + Open API** `cliCredentialBootstrap` (MCP `api` /
   `POST /v1/tokens/bootstrap`, scope `tokens:write`) - authenticated by the
   current MCP session or an eligible API token. Returns a one-shot `kody_bc_…`
   bootstrap code + `cli_command`. Never returns `kody_at_…`. The caller must
   choose the eventual token lifetime (`lifetime: "short"|"long"` or both
   `idle_ttl_seconds` and `max_lifetime_seconds`). The returned `cli_command`
   includes matching CLI flags.
2. **Native Open API** `cliCredentialBootstrapRedeem`
   (`POST /v1/tokens/bootstrap/redeem`) - code-authenticated only (no Bearer).
   Burns the code and mints a normal scoped `kody_at_…` for the CLI to store.
   Lifetime is required again on redeem (CLI flags / body). Rejected for the MCP
   `api` tool principal so redeem cannot dump secrets into chat.

Default eventual scopes: `local-execute` + `account:read`. Token parents cannot
escalate scopes or outlive their own `max_expires_at`. `tokenCreate` remains for
CI/headless and power users. Interactive humans who already ran `kody login`
skip bootstrap (0055).

### Required lifetimes (all mints)

Every `tokenCreate`, `cliCredentialBootstrap`, and bootstrap redeem must choose
a lifetime. There is no silent default.

| Choice   | Idle        | Absolute max       |
| -------- | ----------- | ------------------ |
| `short`  | 1 hour      | 24 hours           |
| `long`   | 14 days     | 3 months           |
| explicit | 60s-14 days | ≥ idle, ≤ 3 months |

Aliases are input sugar only. Store only the resulting idle timeout and absolute
expiry. Do not store a short/long label on the token.

```json
{ "operationId": "cliCredentialBootstrap", "params": { "lifetime": "short" } }
```

```bash
npx @kodycodes/cli auth bootstrap --code 'kody_bc_…' --lifetime short
```

```json
{
	"operationId": "tokenCreate",
	"params": {
		"name": "ci-bot",
		"scopes": ["account:read", "search:read"],
		"lifetime": "short"
	}
}
```

Missing lifetime fails with the exact flag / field syntax (CLI:
`--lifetime short|long` or both `--idle-ttl-seconds` and
`--max-lifetime-seconds`).

### Active-token cap and reclaim

At most **500** active API tokens per account. When a mint would exceed the cap,
`mintApiToken` revokes the active token(s) with the least remaining life until
one slot is free, then mints. Remaining life is time until the stored
`expires_at` (already the sooner of the sliding idle window and
`max_expires_at`, so rotation and use stay accurate). A post-insert reclaim
heals concurrent races by only considering tokens created strictly before the
just-inserted row, so a sibling mint from the same race is kept (soft overshoot
until the next mint). HTTP bootstrap redeem runs under the account write lease.

This policy applies to **every** mint (`tokenCreate`, bootstrap redeem, and any
other `mintApiToken` caller). It does not special-case by token name or
`created_via`. It never revokes the caller's own token when the mint is
authenticated by an API token (`excludeTokenId`). MCP session and code-only
redeem have no caller token to protect. Redeem lifetime cannot exceed the
idle/max stored on the bootstrap code at mint (parent clamps stay enforced).
Redeem also rejects (without burning the code) when the authorized absolute
window (`created_at + max_lifetime_seconds`) has already ended, so a late redeem
never returns an already-expired token.

**Amended 2026-10-27:** `cliCredentialBootstrap` is not callable from `execute`
code. Hosted execute has no `openApiPrincipal`, and the CapabilityProxy hop
behind `execute --local` sets a host-only `localExecuteHop` marker; both are
refused with a message pointing at the MCP `api` tool. Code a model wrote (or a
package it imported) cannot mint itself a CLI credential; the explicit `api`
call stays the handoff.

Do **not** add OAuth device flow (superseded for the official CLI by
[0082](./0082-cli-oauth-device-authorization-grant.md)). Do **not** accept
bootstrap codes as general Open API Bearers. Do **not** scavenge host MCP tokens
from disk. Do **not** keep a flagless / default-lifetime mint path.

## Consequences

- New D1 table `cli_credential_bootstrap_codes` (hash + TTL + one-shot).
- `api_tokens.created_via` gains `cli-bootstrap`.
- HTTP handler allows one unauthenticated route (redeem), rate-limited at the
  API edge by IP.
- CLI companion:
  `npx @kodycodes/cli auth bootstrap --code … --lifetime short|long` (or
  explicit idle/max flags) redeems and stores the API token for `--local`.
- Agent tips prefer bootstrap (or login) over `tokenCreate` for interactive
  local execute; single-task agents use `short`.
- Ordinary and bootstrap tokens share the same idle/max ceilings (14 days / 3
  months). Cap reclaim is generic in `mintApiToken`.
- **As of Teams P4 + 0092 + later amendments:** default eventual scopes are the
  pre-P4 `local-execute` + `account:read` parity set under org permissions:
  `org:execute`, `org:read`, and the use-level scopes saved packages need
  (`package:execute` / `package:read`, `integration:read` / `integration:use`,
  `secret:use`, `email:read` / `email:send`, `job:read` / `job:execute`,
  `app:read` / `app:execute`, `memory:read`), plus `package:write` (plain-repo /
  package pushes), `package:create` (`packageGetGitRemote` create stubs), and
  `token:delete` (self-revoke). `createAuthenticatedFetch` calls
  `integrationGet` (`integration:read`); without it, every integration package
  fails closed on CapabilityProxy. Do not mint `search:read`, the original
  `local-execute` / `account:read` names, or `tokens:write`. Parent tokens still
  cannot escalate scopes or outlive their own `max_expires_at`.
