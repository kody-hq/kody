# 0053: Scoped API tokens are a separate credential class, not MCP OAuth scopes

- **Status:** accepted
- **Date:** 2026-09-30
- **Amended:** 2026-10-09 (Teams P4: token scopes are org permissions)

## Context

The Open API (`api.kody.codes`) and local execute (`@kodycodes/cli`, the
CapabilityProxy) need a bearer credential a script or a local workerd can hold
without the owner's full MCP grant.
[0049](./0049-no-mcp-capability-oauth-scopes.md) keeps MCP OAuth as one
full-access grant and names this exact case as its revisit-if: a second
credential class that must be weaker than the owner's assistant.

Three shapes were on the table: add scopes to MCP OAuth tokens, let the CLI
reuse (scavenge) the host's MCP OAuth token, or mint a separate short-lived,
scoped token.

## Decision

The third. Account API tokens (`kody_at_<id>_<secret>`, table `api_tokens`) are
their own credential class: per-resource `:read` / `:write` scopes plus
`search:read` and `local-execute`, a sliding idle TTL (default 15 minutes), an
absolute lifetime cap, rotate, and revoke. They authenticate only the Open API
and the CapabilityProxy, never `/mcp`. An agent mints one through the MCP `api`
tool (or an existing token with `tokens:write`) and hands it to the CLI.

MCP OAuth stays exactly as 0049 decided: one grant, OIDC trio only, no
capability scopes. The CLI does not read MCP OAuth tokens and there is no second
device login. Kody does not push work from the cloud to a local venue.

## Consequences

- Token scopes are enforced by the Open API (`packages/worker/src/api-tokens/`,
  `packages/worker/src/open-api/`), not by the MCP registry. The MCP `api` tool
  runs with the session's full grant, so scopes do not apply to it.
- Do not add scopes to MCP OAuth, and do not accept `kody_at_` tokens on `/mcp`.
- Do not reuse webhook handles as account bearers
  ([0048](./0048-webhooks-replace-invocation-tokens.md)). HTTP package
  invocation tokens were removed.
- **Amended by [0055](./0055-cli-mcp-oauth-local-execute-http.md):** CLI-owned
  `kody login` MCP OAuth may authenticate CapabilityProxy and package-graph only
  (full MCP grant). Other Open API routes stay `kody_at_`-only; the CLI still
  must not scavenge **host** MCP OAuth.
- **Amended by [0056](./0056-cli-credential-bootstrap.md):** agents already on
  MCP mint a one-shot `kody_bc_…` bootstrap code (not a `kody_at_`) via
  `cliCredentialBootstrap`; the CLI redeems it for a scoped API token. This is
  an explicit handoff, not host-token scavenging.
- **Amended (Teams P4):** token scopes are org permissions (`org:execute`,
  `org:read`, `package:read`, …). There is no write-implies-read hierarchy and
  no `account:read` / `local-execute` / `tokens:write` names. Parent tokens
  still cannot escalate scopes.
- **Amended by [0082](./0082-cli-oauth-device-authorization-grant.md):** the
  official CLI may log in with the OAuth device grant. It is the same CLI
  credential as `kody login`, not a host-token scavenge.
- Revisit if an MCP host needs a weaker-than-owner MCP session that an API token
  plus the Open API cannot serve.
