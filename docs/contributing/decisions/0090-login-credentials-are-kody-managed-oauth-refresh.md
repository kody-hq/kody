# 0090: `login` credentials are Kody-managed OAuth refresh

- **Status:** accepted
- **Date:** 2026-10-29
- **Amends:** [0068](./0068-credentials-own-placement-scoped-clients.md) (the
  `login` kind)

## Context

ADR 0068 added the `login` credential kind: the value holds login fields, the
credential's `login_exchange` turns them into a session token, and the gateway
places that token on the credential's hosts. Sessions were kept per isolate
only, so every new isolate ran the exchange again, a 401 never refreshed, and a
provider that rotates its refresh token could not be used. Package authors
filled the gap with a package-scoped refresh secret plus a stored access token,
which puts both tokens where code can read them. Issue #4457 asked for the same
for a refresh token that comes back sealed from a token exchange.

## Decision

Kent decided on 2026-10-29 that the `login` credential kind becomes Kody's
platform-managed OAuth refresh, and #4457 is folded into it:

- Kody holds the refresh token as the `login` credential's value, runs the token
  request on the host, keeps the access token encrypted on Kody's side, and
  fills it on the credential's hosts.
- Code never holds a refresh token or an access token.
- There is no package-scoped storage for sealed tokens.

This is built in steps, each recorded here as it lands:

- **Persisted session.** The session token is stored in
  `login_credential_sessions`, encrypted with its own `login-credential-session`
  purpose from the secret-store key family and bound to the owner, credential
  id, and revision. The revision is a digest of the credential's ciphertext,
  exchange, hosts, and inject, so editing or rotating any of them strands the
  session, and deleting the credential deletes it. The session lasts until
  `expiresInPath` or `ttlSeconds` says it ends (24-hour cap, 30-second skew).
  The per-isolate map stays as a front cache. Use authorization, host, and
  placement checks run on every resolution before a session is used, so losing
  org access or a grant stops use of the session at once.
- **Single-flight across isolates.** One exchange runs at a time per credential,
  through a D1 lease row with a conditional write (the same shape as the
  integration token refresh lease on `user_integrations`). Other callers poll
  and reuse the winner's stored session. A crashed holder's lease lapses after
  60 seconds; a waiter gives up after twice the lease.
- **401 retry.** When one of the credential's hosts answers 401 to a
  `credential(key)` login fetch without a request body, the gateway drops that
  session (only if it is still the stored one), resolves the credential again
  (Use, host, and placement checks included), and retries the request once. A
  second 401 is returned as is. A request with a body is never replayed.
- **Rotated refresh token.** `login_exchange.refreshToken` (`path` in the
  response, `field` of the login value it replaces; strict, and `field` must be
  one the body sends) lets Kody save a rotated refresh token. The new value and
  the new session are written in one D1 batch: the value write is a
  compare-and-swap on the credential's ciphertext, exchange, hosts, and inject,
  and the session lands only if it did. The audit records a value replacement
  with no value. Setting it follows the same rules as `login_exchange`: owner,
  outside a package, together with a value. It is not website-only because it
  never widens where a value goes: the rotated token returns to the same
  credential, with the same hosts and inject.

## Consequences

- A `login` credential now signs in once per session lifetime across all
  isolates and runs, rather than once per isolate.
- Session ciphertext is operational state: account and org deletion remove it,
  and account export omits it.
