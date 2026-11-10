# 0091: Agents register people with auth.md `service_auth`, and Kody issues a `kody_at_`

- **Status:** accepted
- **Date:** 2026-10-30
- **Amends:** [0056](./0056-cli-credential-bootstrap.md),
  [0082](./0082-cli-oauth-device-authorization-grant.md)

## Context

People should be able to start with Kody by asking an agent that has a shell to
connect. The [auth.md protocol](https://github.com/workos/auth.md) (WorkOS,
v0.6.0) standardizes agent-initiated registration: an `agent_auth` block in the
authorization server metadata, `POST /agent/identity`, a claim ceremony shaped
like RFC 8628, and polling the token endpoint with
`urn:workos:agent-auth:grant-type:claim`. It offers three registration types:
`identity_assertion` (an ID-JAG from the agent's provider), `service_auth` (the
agent names the person's email), and `anonymous` (a pre-claim principal).

[0056](./0056-cli-credential-bootstrap.md) requires `tokenCreate` to choose a
lifetime; bootstrap defaults to the login lifetime.
[0082](./0082-cli-oauth-device-authorization-grant.md) runs RFC 8628 on Kody's
authorization server for the official CLI only.
[0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md) keeps `kody_at_`
tokens off `/mcp`, so MCP hosts keep running MCP OAuth.

## Decision

Kent decided on 2026-10-29:

1. **`service_auth` only.** `POST /agent/identity` accepts
   `{ "type": "service_auth", "login_hint": "<email>" }`. `anonymous` answers
   `anonymous_not_enabled` and `identity_assertion` answers
   `issuer_not_enabled`.
2. **Spec wire format.** The authorization server metadata adds `agent_auth`
   (`skill`, `identity_endpoint`, `claim_endpoint`,
   `identity_types_supported: ["service_auth"]`) and the claim grant in
   `grant_types_supported`. Registration returns `claim_token`,
   `claim_token_expires` (24 hours), `post_claim_scopes`, and a `claim` block
   (`user_code`, `verification_uri`, `expires_in` 600, `interval` 5).
   `POST /agent/identity/claim` with the same `claim_token` and email mints a
   fresh attempt. Kody never emails the code; the agent shows it to the person.
3. **Shared device-grant pieces.** Registrations reuse the 0082 user code
   alphabet and format, SHA-256 storage of every bearer value, verification rate
   limits, and retention purge. They get their own D1 table because they bind a
   claim email and mint a `kody_at_` directly instead of an OAuth grant.
   `/oauth/device_authorization` stays limited to the official CLI.
4. **Claim page.** The verification URI goes through sign-in or sign-up. Sign-up
   is the normal flow, so the person chooses their own permanent username before
   the account exists. Completing the claim needs a signed-in person whose
   verified account email matches the `login_hint`, the typed code, and an org
   choice on a consent screen like `/device`.
5. **Credential.** The claim grant's success response is a standard token
   response whose `access_token` is a user-owned `kody_at_` (`created_via`
   `agent-registration`) with `cliCredentialBootstrapNarrowScopes`, bound to the
   chosen org. auth.md agents send no lifetime, so this mint defaults to `long`;
   the body may ask for `short` or explicit seconds with the
   [0056](./0056-cli-credential-bootstrap.md) lifetime fields.
6. **A Kody profile of auth.md: no `identity_assertion` and no JWT-bearer
   grant.** The spec's claim grant success response adds `identity_assertion`
   and `assertion_expires` so the agent can mint new access tokens with the
   JWT-bearer grant. Kody's response omits both, and its metadata does not list
   the JWT-bearer grant. The token slides on use. When it expires or is revoked,
   the agent registers again with `POST /agent/identity`. 0076 removed refresh
   tokens from the CLI, and a long-lived assertion would bring one back.
7. **Rate limits.** `/agent/identity` is limited per IP and per `login_hint`.
   Code entry is limited per person and per IP, and only misses count.

Anonymous registration through `POST /agent/identity` stays off and keeps
answering `anonymous_not_enabled`.

### Amendment: guest accounts from the OAuth screen

People without an account get a guest account a different way, and this section
replaces the earlier anonymous sketch:

1. **One entry point.** The signed-out OAuth authorize screen offers Try it out
   next to Log in and Sign up. It creates the guest person and personal org in
   one D1 batch, then finishes the normal OAuth authorization for the requesting
   client (an MCP host or `kody login`). Agents cannot mint guests on their own,
   and there is no CLI guest flag.
2. **Guests are allowed on `/mcp`** with the guest limit overrides: about $1 of
   house compute with a hard stop, no email sends, and tight execute, fetch,
   job, and automation caps. Creation is rate limited per IP and platform-wide
   per day.
3. **24 hours of full access, then a 7-day read-only hold** instead of deleting
   at 24 hours. During the hold reads work and writes and execute answer
   `guest_claim_required`. After the hold the purge lane deletes the account
   with `deleteUserAccount()`, and its tokens answer `invalid_token`.
4. **Blocked for guests** (`guest_not_allowed`): storing credentials, connecting
   integrations, public or internet-visible packages, creating or joining orgs,
   invites, and community listings. Every guest error carries the claim link and
   names the `guestClaimStart` capability.
5. **The same grant is kept at claim.** Claiming never redoes OAuth or login. A
   claim into a new account converts the guest in place. A claim into an
   existing account moves packages (renaming clashes), memories, jobs, run
   history, and referral credit into that person's personal org, repoints the
   guest's OAuth grants and API tokens through a guest alias, then deletes the
   empty guest without revoking those grants. The $5 welcome credits arrive at
   claim.
6. **Claim paths.** `/claim/<code>` takes a verified email code, GitHub, or
   Google. Agents can run the claim with `guestClaimStart` (email plus a
   username or a merge request; Kody emails a one-time code) and
   `guestClaimFinish` (the code the person reads back).

## Consequences

- 0056: `tokenCreate` still requires a lifetime. CLI bootstrap and auth.md
  registration default to `long`.
- 0082: the device grant's code and verification pieces have a second caller.
  The device authorization endpoint itself is still CLI only.
- MCP hosts are unchanged. After a claim, an agent installs Kody MCP and the
  host runs normal OAuth with the person already signed in.
- Revisit if a major agent provider ships ID-JAGs (add `identity_assertion` with
  the spec's first-link step-up), if auth.md changes `service_auth` or the
  WorkOS-namespaced claim grant URN, or if abuse reports show the per-email and
  per-IP limits are not enough.
