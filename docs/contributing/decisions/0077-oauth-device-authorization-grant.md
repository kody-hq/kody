# 0077: OAuth device authorization grant (RFC 8628)

- **Status:** accepted
- **Date:** 2026-10-17

## Context

Some OAuth providers (and headless agent flows) cannot complete a browser
redirect authorization_code grant. RFC 8628 defines a device authorization
grant: the client shows a `user_code`, the user approves on another device, and
the client polls the token endpoint with a `device_code`. Kody already hosts
`/connect/oauth` and MCP integration capabilities for code grants; device needed
the same product surface without exposing provider secrets to the browser or MCP
tool outputs.

## Decision

1. **One server backend, two entry points.** `device_start` and `device_poll` on
   `/account/secrets.json` power the browser UI. MCP
   `integrationDeviceConnectStart` / `integrationDeviceConnectPoll` call the
   same resolve → `startDeviceAuthorization` / `pollDeviceAuthorization` →
   `persistConnectOauthTokens` path
   (`packages/worker/src/integrations/device-connect.ts`,
   `connect-oauth-persist.ts`, `device-flow.ts`).
2. **`device_code` and client secret never leave the server.** Callers receive
   an opaque KV session id, `user_code`, verification URI, expiry, and poll
   interval. On approve, tokens persist on the connection; outputs report
   metadata only (integration name, refresh-saved flag).
3. **Additive config.** `user_oauth_apps` / `platform_oauth_apps` gain optional
   `device_authorization_url` and `flow = 'device'`. Existing rows are
   unchanged; no data migration of live connections is required beyond the
   nullable column add (migration `0165`).
4. **Public and confidential device clients.** Device grant is orthogonal to
   client authentication: a client secret is optional. Token poll / refresh use
   confidential auth only when a secret is available.

## Consequences

- `/connect/oauth?flow=device&deviceAuthorizationUrl=…&tokenUrl=…` is the
  interactive path; MCP is for agents that cannot open that page.
- Rehearsal mocks expose `/__mocks/rehearsal/oauth/device/authorize` and extend
  the token endpoint for the device_code grant so previews can exercise the full
  poll matrix (pending, slow_down, denied, expired, success).
- Revisit if a provider requires browser cookies on the verification URI that
  the hosted connect page cannot open for the user.
