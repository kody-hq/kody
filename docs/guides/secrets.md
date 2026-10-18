---
id: secrets
title: Secrets
summary:
  How Kody lets your agent use your API keys, tokens, and private keys without
  ever reading them: the no-secret_get rule, `{{secret:name}}` placeholders
  resolved at the network boundary, host approval, package approval (website
  Allow links via `secretLock`), and expiry. Keys are one credential kind; the
  Credentials guide covers every kind. Load this when someone asks whether the
  agent can see a key.
category: platform
---

# Secrets

A secret is a credential stored on your Kody account — an API key, a personal
access token, a webhook signing secret, a private key. Your agent can write code
that uses a secret. It can never read one — including via `packageSecrets.get`,
which returns only an opaque `{{secret:…}}` placeholder for platform use sites
(fetch, `secretHeaders`, `secretJwtSign`) to resolve.

Watch:
[Make your agent safe and autonomous](https://www.youtube.com/watch?v=_EJTrJFLa3g)
for the locked Gmail drafts loop, written up in
[Gmail drafts without send](./locked-gmail-drafts.md).

## The rule: there is no `secret_get`

The secrets capabilities are `secretList`, `secretSet`, `secretSetMany`,
`secretLock`, `secretDelete`, and `secretJwtSign`. No capability returns a
secret value. `secretList` returns metadata only: names, descriptions, approved
hosts, expiry, remaining time to live, and `package_id` for package-scoped
secrets. Explicit listing includes caller-owned package-scoped metadata even
from execute; using a package secret still requires package context. Search does
not return or rank those rows. `secretLock` returns grant-status metadata and an
`approval_url` for the owner to click; it does not apply the grant. External
vaults use [custom secret providers](./secret-providers.md) (`secretProvider*`
capabilities and `{{secret/<provider>:<ref>}}` placeholders).

This is why you can hand an agent a job that needs your GitHub token without the
token ever entering the prompt, the transcript, or the model provider's logs.
The same is true for every agent connected to the account: the secret is shared;
the value is shared with none of them.

## How code uses a secret

Code refers to a secret by name. Kody substitutes the value at the network
boundary, on the final serialized request, and only for hosts you approved.

- **Placeholders in `fetch`** — `{{secret:githubAccessToken}}` anywhere in an
  outbound HTTPS `fetch` (a header, the URL path or query, or a text body)
  resolves when the request leaves Kody, if the host is one you approved for
  that secret. On plain `http://` or an unapproved host the request is refused
  with an error naming the secret and host; a placeholder is never sent
  unfilled. External providers use the same boundary; see
  [Custom secret providers](./secret-providers.md). This is not general string
  interpolation; it works only in secret-aware `fetch`.
- **Derived headers** — when an API wants Basic Auth built from two secrets,
  `secretHeaders.basic({ usernameSecret, passwordSecret })` from `kody:runtime`
  produces the header without exposing either half. Each secret argument accepts
  a saved secret name **or** an opaque `{{secret:…}}` ref from
  `packageSecrets.get`.
- **Signed JWTs** — `secretJwtSign` signs a JWT with a stored key and returns
  the compact token, never the key. HMAC (`HS256` / `HS384` / `HS512`) reads key
  material from the saved secret (`key_encoding` defaults to `base64`) and
  rejects keys shorter than 32, 48, or 64 bytes (JWA). `RS*`, `PS*`, `ES*`, and
  `EdDSA` use a PKCS#8 PEM private key. Pass the secret as
  `private_key_secret_name` (name **or** opaque `{{secret:…}}` ref).

Placeholders are live tokens. Do not paste one into an issue body, a comment, a
log line, or a returned string — write `{{secret:<name>}}` with angle brackets
when you need to mention the syntax in prose.

## Two approvals, both yours

Saving a secret does not by itself let anything use it.

- **Host approval** decides which destinations a secret may be sent to. A secret
  with an empty host allowlist blocks every placeholder fetch, including from
  packages you wrote yourself. Approve hosts on `/connect/secrets` — one link
  can cover several secrets and several hosts at once. Hosts that are not valid
  hostname shapes (truncated tokens, paths, empty values) are flagged on that
  page and are not written to the allowlist. Kody never approves a host
  automatically; an ad hoc smoke test that happened to work does not widen the
  allowlist.
- **Package approval** decides which saved packages may read and use a
  user-scoped secret. Approval is checked against the stamped package — the
  module that originated the call — so dependents statically import the owning
  export instead of needing their own grant. Packages you authored and community
  forks you adopted after reviewing the source get read/use automatically.
  Unadopted forks need an explicit grant. Updating or deleting a user secret
  from package code always needs the grant. Only the account owner can add a
  package to that grant on `/@<slug>/-/secrets/user/:name` or
  `/@<slug>/-/secrets/approve` — a focused Allow page, the same spirit as host
  approval on `/connect/secrets`. `secretLock` returns that approval URL for the
  owner to click; it does not change `allowed_packages`. Send the link and wait.
  Removing a grant is also website-only.

Bulk approval URLs (`/@<slug>/-/secrets/approve?package_id=…&names=a,b`) let you
approve several pending secrets for one package in a click.

Starting Tuesday, Oct 21, 2026, a non-empty `allowed_packages` list is enforced
for every package use of that credential (including when the package is used
through another package or loaded in a one-off `execute` run). Publish and save
may warn beforehand when a package fills a credential it is not listed for;
approve the package or move the use into an already-allowed package.

## Scopes

- **User secrets** belong to the account and can be approved for any package.
- **Package secrets** belong to one saved package. They are package config,
  keyed by the package id, and can be used only with package context.
  `secretList` and `packageGet` expose their metadata with `package_id` even
  outside an active package run. Search does not return or rank those
  references. **Creating or updating package-scoped secrets from
  `kody execute --local` is unavailable** — local CapabilityProxy does not
  attach package secret authority (and must not trust a client-supplied package
  id). Prefer hosted package execute, `/connect/secret-set`, or Open API
  `secretSet` outside local execute. Details:
  [Local CLI execute](./local-execute.md#failure).

A Use collaborator running your package in **your** org uses **your** org's
secrets and integrations under the same host and package allowlists — they still
cannot read secret values. Details:
[Share a package](/docs/package-sharing#secrets-and-integrations-on-a-granted-run).

OAuth access and refresh tokens are different: they live on the integration,
rotate through `createAuthenticatedFetch`, and do not appear in the secrets
list. A pasted API key is a secret; a Slack login is an integration. See
[Packages, integrations, and MCP servers](./packages-integrations-mcp.md).

## Expiry

A secret can carry an expiry (`expires_at`). Expired secrets stay listed with
`ttl_ms: 0`, and placeholders treat them as missing so Kody stops sending the
value. Agents prefilling `/connect/secret-set` can set `expiresAt` in the query
string so the person pastes the token without typing a date.

## When a token is coarser than the job

Providers do not always offer the scope you want. Gmail has a send scope and no
drafts-only scope. When the token can do more than the job should, publish the
narrow behavior as a package, lock the package, and lock the integration to it.
After that, `execute` cannot borrow the token and a later publish cannot quietly
add a send path. See [Gmail drafts without send](./locked-gmail-drafts.md) and
[Lock an MCP server to a package](./locked-mcp-server.md) for the same pattern
on connected tool servers.

## Adding a secret

- Pasting a key or PAT: the agent sends you a prefilled `/connect/secret-set`
  link; you paste the value into the page, never into chat. URL shape and
  parameters: [Secret setup URL reference](./account-secret-setup.md).
- Building an integration around one or more secrets:
  [Secret-backed integrations](./secret-backed-integration.md).
- Using a password-manager item without pasting it into Kody:
  [Custom secret providers](./secret-providers.md).
- A token that already exists inside trusted code (a key the package just
  minted): `secretSet` persists it without returning it.

## Where to go next

- [Credentials](./credentials.md) — every credential kind, scoped clients, and
  `kody.credentials` needs.
- [Secrets and host approval](../use/secrets-and-values.md) — the MCP-level
  reference with the exact placeholder, header, and approval semantics.
- [Custom secret providers](./secret-providers.md) — vault placeholders, account
  binding, and package grants.
- [Integration bootstrap](./integration-bootstrap.md) — the sequence before a
  secret-backed package is saved.
