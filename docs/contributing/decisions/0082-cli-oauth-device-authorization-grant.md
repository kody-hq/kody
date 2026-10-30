# 0082: OAuth device authorization grant for the Kody CLI

- **Status:** accepted
- **Date:** 2026-10-28
- **Amends:** [0056](./0056-cli-credential-bootstrap.md),
  [0076](./0076-cli-login-device-token.md)
- **Amended:** 2026-10-30 by [0091](./0091-auth-md-service-auth-registration.md)
  (code and verification pieces shared with auth.md registration)

## Context

`kody login` is an authorization_code grant whose redirect is fixed at
`http://127.0.0.1:43742/callback` (CIMD needs an exact redirect,
[0055](./0055-cli-mcp-oauth-local-execute-http.md)). The browser must run on the
same machine as the CLI, so people on remote VMs, NAS boxes, or SSH sessions
could not log in. [0056](./0056-cli-credential-bootstrap.md) said not to add an
OAuth device flow and pointed agents at bootstrap codes, which need an existing
MCP session. A person at a terminal has no such session.

[0077](./0077-oauth-device-authorization-grant.md) is the other direction: Kody
as a device-flow client of third-party providers. This ADR is Kody's own
authorization server acting as the device-flow server.

## Decision

1. **RFC 8628 on Kody's authorization server.**
   `POST /oauth/device_authorization` (advertised as
   `device_authorization_endpoint`, with
   `urn:ietf:params:oauth:grant-type:device_code` in `grant_types_supported`, in
   both `/.well-known/oauth-authorization-server` and the OpenID configuration)
   returns a `device_code`, an 8-letter `user_code` (RFC 8628 consonant
   alphabet, shown as `XXXX-XXXX`), `verification_uri` (`/device`),
   `verification_uri_complete`, a 10 minute lifetime, and a 5 second interval.
   `/oauth/token` answers `authorization_pending`, `slow_down` (interval grows
   by 5 s), `access_denied`, `expired_token`, and `invalid_grant` for unknown or
   reused codes.
2. **Official CLI only, by config.** The grant is limited to the CLI CIMD client
   id (`${origin}/oauth/cli-client-metadata.json`) from
   `packages/worker/src/oauth-device/device-grant.ts`. Other clients get
   `unauthorized_client`. Allowing another public client later is adding its id
   to that list.
3. **Same grant as the browser flow.** An approved request is consumed once,
   then turned into a normal provider grant with `completeAuthorization` (same
   props and org binding as `/oauth/authorize`) and redeemed internally with a
   server-held PKCE verifier. The device receives the provider's own token
   response, so 0055 and 0076 accept it unchanged: the CLI exchanges the access
   token at `POST /v1/tokens/device` and stores only the `kody_at_` device
   token, exactly like the browser flow.
4. **Verification page.** `/device` requires a signed-in session, takes or
   confirms the code (prefilled from `verification_uri_complete`), and shows a
   consent screen naming the client, the scopes, the org, and "Only continue if
   you started this sign-in yourself on a device you control." Approve needs a
   verified email, like authorize. Code entry is rate limited per person and per
   IP; only misses count.
5. **Storage.** D1 table `oauth_device_authorizations` stores the SHA-256 of the
   `device_code`, never the code itself. Rows are purged a day after they expire
   and are covered by account deletion.
6. **CLI.** `kody login --device` prints the URL, code, and complete URL, polls,
   then finishes like `kody login`. The browser flow stays the default; it
   suggests `--device` over SSH, with no display, when the browser cannot be
   opened, or when the callback port is busy.

## Consequences

- 0056's "Do not add OAuth device flow" no longer holds for the official CLI.
  Bootstrap codes stay the agent handoff for MCP sessions.
- 0053's "no second device login" is superseded for humans: the device flow is
  another way to run `kody login`, not a host-token scavenge.
- Revisit if another public client needs the grant, or if phishing reports show
  that consent copy alone is not enough.
