# 0076: CLI login mints a device API token

- **Status:** accepted
- **Date:** 2026-10-16
- **Amends:** [0055](./0055-cli-mcp-oauth-local-execute-http.md)

## Context

`@kodycodes/cli` calls the versioned HTTP API instead of an MCP client. Open API
routes accept `kody_at_…` bearers. `kody login` OAuth access tokens are a
different credential class
([0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md)) and are accepted
only on local-execute HTTP ([0055](./0055-cli-mcp-oauth-local-execute-http.md)).
Hosted execute needs a `kody_at_…` with `org:execute`.

Published CLIs that speak MCP stay on `/mcp`. Local execute for those CLIs stays
on the 0055 routes.

## Decision

1. `POST /v1/execute` is a native Open API operation. It runs the same module
   path as the MCP `execute` tool and returns that tool's envelope. Auth is
   `kody_at_…` plus `org:execute`. CLI MCP OAuth is rejected.
2. `POST /v1/search/tool` is the MCP `search` tool (`search:read`), including
   entity detail. `GET /v1/search` stays the search capability.
3. `POST /v1/tokens/device` accepts the official CLI OAuth access token (same
   CIMD client id as 0055) and returns a user-owned `kody_at_…` once. Scopes are
   the org-permission vocabulary; the caller role still applies. The route
   requires a lifetime. `kody login` stores that device token and does not keep
   an OAuth refresh token.
4. Local-execute HTTP still accepts CLI MCP OAuth so older CLIs keep working.
   `/mcp` is unchanged.

## Consequences

- New CLI logins are revocable `kody_at_…` tokens with idle and max expiry.
- `kody api`, search, and cloud execute use that token.
- A login session can mint bootstrap codes for any scope the org role grants,
  because the device token holds the full permission vocabulary.
- npm publishes of `@kodycodes/cli` from this repo use trusted publishing. The
  previous package line continues from 1.26.3.
- **Amended by [0082](./0082-cli-oauth-device-authorization-grant.md):**
  `kody login --device` gets the same CLI OAuth access token through the RFC
  8628 device grant and exchanges it at `POST /v1/tokens/device` the same way.
