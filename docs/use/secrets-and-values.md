# Secrets and host approval

## Secrets

Credential setup uses **saved secrets**, **`/connect/oauth`** for OAuth,
**`/connect/secret-set`** for API keys and PATs, or execution-time persistence
when a token already exists inside trusted code.

Use **search** first to discover saved secret references or integrations before
switching to **execute**.

During **execute**, **`await kody.secretList({})`** (or a narrowed **`scope`**
such as **`package`**) returns **metadata only**: names, descriptions, allowed
hosts, **`package_id`** for package-scoped secrets, **`expires_at`**, and
remaining **`ttl_ms`** — not plaintext values. Explicit listing includes
caller-owned package-scoped metadata even without a package runtime; using a
package secret still requires package context. **search** does not return or
rank package-scoped secret references. Expired secrets stay in the list with
**`ttl_ms: 0`**. Fetch placeholders and **`resolve`** treat them as missing so
Kody stops sending the value.

Package-scoped secrets belong to one saved package. **`packageGet`** includes
their metadata as an FYI when you are inspecting that package. User-scoped
secrets follow the bundler stamp: code that originates from package A authorizes
as A, including when B statically imports A's export. B's own code still cannot
read a secret locked only to A — including by passing A's id to
`kody.packageSecretGet` / `Has`. Only A's stamped `packageSecrets` binding
carries that authority. Access rules are covered in
[Package approval](#package-approval).

`packageSecrets.get(alias)` (and `kody.packageSecretGet`) return an **opaque
`{{secret:…}}` placeholder** after mount and grant checks succeed — never
decrypted plaintext. Put that string anywhere in a secret-aware `fetch` request
(see [Placeholders in `fetch`](#placeholders-in-fetch)), or pass it to
`secretHeaders.basic` / `kody.secretJwtSign` (both accept saved secret names
**or** opaque refs). Only platform use sites resolve it. Package and execute
JavaScript never receive plaintext from `get`. A secret-aware `fetch` may send
the value to an **approved** host. If that host echoes the value back, the
gateway redacts it from the response (see
[Placeholders in `fetch`](#placeholders-in-fetch)); treat response bodies as
untrusted all the same.

**`kody.secretSet(...)`** persists a value that is already available inside
execution (for example an API key the package just minted). It does not return
secret values. Do not use it for OAuth access or refresh tokens —
`/connect/oauth` and **`createAuthenticatedFetch`** /
**`integrationTokenRefresh`** persist those on the connection. Optional
**`expires_at`** is a UTC ISO timestamp (or `YYYY-MM-DD` at midnight UTC). Omit
it to leave an existing expiry unchanged; pass `null` to clear. Updates that
only change description or expiry may omit **`value`**. Package runtimes cannot
change expiry on a user secret.

### Opt-in credential fields

A saved secret is a **Key** by default. Keys fill placeholders and use host
approval as described here. A user-scope **`secretSet`** from execute or the API
(not from a package runtime) can also set fields for the opt-in credential types
(ADR 0068):

- **`kind`**: `secret` (a Key, the default), `url` (a whole webhook URL),
  `login` (a JSON object of login fields), or `signing` (a signing key). The
  opt-in kinds are never placed by a placeholder; a package reaches them only
  through a scoped credential client.
- **`hosts`**: where an opt-in kind may be sent, as bare exact hosts or one
  wildcard level under a registrable domain (`*.example.com`, not
  `*.github.io`); a scheme, port, or path is refused. Required for `url`,
  `login`, and `signing`; a `url` value's own host must be one of them. Keys
  refuse `hosts` and keep using host approval.
- **`login_exchange`**: for `login`, how the fields become a session token. Its
  url must be on one of the hosts and carry no username or password.
- **`provider`** and **`inject`**: which package credential needs the credential
  can satisfy (for example `github`), and how a scoped client places it (a
  header with a `{value}` format, basic auth, or a query parameter; a `login`
  session token uses a header or query parameter). The default placement is
  `Authorization: Bearer {value}`. Placeholders ignore both.

`kind`, `hosts`, and `login_exchange` are set only together with a value:
whoever supplies the value decides where it may go. A new value for an existing
opt-in credential is checked against its stored hosts. Setting `kind: "secret"`
turns an opt-in credential back into a Key and clears its hosts. The value and
these fields are saved together or not at all. **`provider`** and **`inject`**
can change without a value (in a call of their own; the secret's value and
`updated_at` stay as they are), and **`credentialUpdate`** sets them by
credential id on secrets, OAuth connections, and MCP servers (OAuth connections
and MCP servers always use `Authorization: Bearer`, so only their provider
changes). Every change needs Write on the credential and is audited.

### Personal credentials in a team org

A secret, OAuth connection, or MCP server in your personal org is a personal
credential. Grant it to a team org you belong to with **`credentialOrgGrant`**
(`credential_id`, and `org` as a slug; `org` defaults to the org the request is
bound to). It then works in that org only in your own runs, through scoped
`credential(key)` clients (see [Packages](./packages.md)). Nobody else in that
org can use it, Owners and Automation included, and `{{secret:name}}`
placeholders never resolve it. **`credentialOrgRevoke`** removes one org's grant
at once, and **`credentialOrgGrantList`** lists your grants, with
`active: false` when one stops working (an expired value, a disconnected OAuth
connection, a disabled MCP server, or you left the org). Leaving an org deletes
your grants there. Granting and revoking need a live person (not a job, webhook,
or package code) and Write on the credential; grants and revokes are audited in
your personal org.

The account create/edit form has the same optional expiry field. Agents
prefilling **`/connect/secret-set`** can set **`expiresAt`** as a query
parameter so the human pastes the token without typing the date. See
[Account secret setup](../guides/account-secret-setup.md).

A connection authorizes _your_ agent — and any code you run or install — to act
as you on that provider. Kody does not control or supervise what your agent does
with the access you grant; scope connections deliberately and revoke unused
ones. See the [Terms](/terms).

## Placeholders in `fetch`

Outbound **`fetch`** can include placeholders such as **`{{secret:tokenName}}`**
or **`{{secret:tokenName|scope=user}}`** anywhere in the request: a header, the
URL path, the query string, a text body (JSON, form-encoded, or plain text), or
a literal `{{…}}` in a `multipart/*` part. The gateway fills them only when both
hold:

- the request is **HTTPS**;
- the request host is one the credential allows: a saved secret's approved
  hosts, an integration's `requiredHosts` and `apiBaseUrl` host, or a vault
  item's websites.

Otherwise the request is refused before any credential resolves, with an error
that names the credential and the host; the gateway never sends a placeholder it
would fill unfilled. A placeholder in the URL host or user info is always
refused, so filling one can never change where a request goes. In a JSON body
each value is JSON-escaped; in a form-encoded body or query string each value is
form-encoded, and the other keys and values keep their bytes as written. In the
URL path each value is encoded as segment data, so a `/`, `?`, or `#` in it
cannot change the route. A placeholder encoded with `encodeURIComponent` in the
URL path or query, or in a form-urlencoded component the gateway already fills,
is found too. Literal `{{…}}` placeholders in `multipart/*` parts are filled the
same way. Streamed bodies are filled chunk by chunk. A percent-encoded or
base64-encoded placeholder form the gateway will not fill is refused, with an
error that names the form.

The `x-kody-secret-resolution` header changes this per request, and Kody strips
it before the request leaves:

- `headers-only` fills header placeholders and sends the URL and body as
  written, for a body that quotes the syntax on purpose (an issue or chat
  message that documents it) on a host the credential allows. Without it, that
  text would be filled with the secret.
- `off` resolves nothing and checks nothing: every placeholder, in the URL,
  headers, or body, is sent as written.

See
[Mentioning placeholders without resolving them](#mentioning-placeholders-without-resolving-them).
Local execute sends a request through the cloud gateway when its URL, headers,
or body hold a placeholder — including streamed and multipart bodies — so fill
matches hosted. Small buffered bodies use the JSON CapabilityProxy hop. Streamed
bodies, multipart bodies, and bodies that would exceed 4 MiB use the
[streaming hop](../contributing/contracts/cli-streaming-gateway-fetch.md).

If the remote echoes a substituted value back, in a response header, status
text, the final URL after redirects, or anywhere in the body, the gateway
replaces it with `[REDACTED SECRET]` before your code reads the response, the
same way run output is redacted. The value is also redacted in its URL-encoded,
form-encoded, and JSON-escaped forms, and from the message of a fetch that
fails. A Basic Auth header is redacted whole and as its encoded credential.
Because the body can change length, `content-length` is dropped from those
responses. Range responses (`206` or `content-range`) are masked with `*` byte
for byte instead, so their offsets stay true. A WebSocket upgrade keeps its
socket and redacted headers, but messages on the socket are not redacted.

External providers use **`{{secret/<provider>:<ref>}}`** (first `:` after
`secret/`). Canonical 1Password form is
**`{{secret/1password:i/<item-id>/password}}`** where `<item-id>` is a UUID or a
1Password Connect 26-char id. `op://…` is a writable synonym that must
canonicalize to the same grant/cache key. The item's websites are the host
allowlist; empty websites refuse the fetch. Ad hoc execute does not need a
package grant; saved packages do (`secretProviderLock` returns the Allow URL).
Bind and revoke on `/@<slug>/-/secret-providers`. Shared packages use the
owner's provider binding. Search does not crawl vaults. See
[Custom secret providers](../guides/secret-providers.md).

When an API requires Basic Auth derived from two saved secrets, import
**`secretHeaders`** from **`kody:runtime`** and put the opaque helper result in
the outbound fetch header. `usernameSecret` / `passwordSecret` accept a saved
secret name **or** an opaque `{{secret:…}}` ref from `packageSecrets.get`. This
example uses a placeholder API host and generic client credential secret names:

```ts
import { secretHeaders } from 'kody:runtime'

await fetch('https://api.example.com/oauth/token', {
	method: 'POST',
	headers: {
		Authorization: secretHeaders.basic({
			usernameSecret: 'exampleClientId',
			passwordSecret: 'exampleClientSecret',
			scope: 'user',
		}),
		'Content-Type': 'application/x-www-form-urlencoded',
	},
	body: new URLSearchParams({ grant_type: 'client_credentials' }),
})
```

Kody resolves both secrets and sends only the derived `Basic ...` header to the
approved host. The target host must be approved separately for both saved
secrets.

Placeholders are **not** general-purpose string interpolation. They only work in
secret-aware **`fetch`** paths.

## Signing JWTs with saved secrets

Use **`kody.secretJwtSign(...)`** when a workflow needs a JWT signed by a key
stored in a saved secret. The primitive returns **`{ jwt, algorithm }`**: use
**`result.jwt`** as the compact JWT and **`result.algorithm`** for the signing
algorithm. It never returns key material.

The caller supplies the JWT header and claims, then performs any provider-
specific token exchange with ordinary **`fetch`**. Pass the saved secret as
**`private_key_secret_name`** — a saved secret name **or** an opaque
`{{secret:…}}` ref from `packageSecrets.get` (PKCS#8 PEM for asymmetric
algorithms, HMAC key material for HS*). For service-account JSON secrets, pass
**`private_key_json_field: "private_key"`** to sign with that field. Supported
algorithms:

- **HMAC:** `HS256`, `HS384`, `HS512` — **`key_encoding`** is **`base64`**
  (default, DoorDash Drive `signing_secret`), **`utf8`**, or **`base64url`**.
  After decoding, the key must be at least 32, 48, or 64 bytes (JWA)
- **RSA PKCS#1:** `RS256` (default), `RS384`, `RS512`
- **RSA-PSS:** `PS256`, `PS384`, `PS512`
- **ECDSA:** `ES256`, `ES384`, `ES512`
- **EdDSA:** Ed25519 PKCS#8 keys (Cursor Origin app JWTs)

## Mentioning placeholders without resolving them

The gateway scans the **final serialized URL, headers, and body**, so a literal
placeholder assembled by any means, including string concatenation, resolves
there. Avoid placing resolvable placeholder tokens into user-visible or
third-party-visible content such as issue bodies, comments, prompts, logs, or
returned strings: sent to a host the credential allows, that text is filled with
the secret.

- To **mention** the syntax in prose or docs, write **`{{secret:<name>}}`**.
  Angle brackets are outside the placeholder name charset (`[a-zA-Z0-9._-]`), so
  this form is inert everywhere — it cannot resolve in this request or any later
  one.
- To send a body that **quotes** the syntax (an issue, comment, or chat
  message), set the **`x-kody-secret-resolution: headers-only`** header on that
  **`fetch`**. Header placeholders still resolve; placeholder text in the URL
  and body is sent as written. Without it the gateway fills that text.
- To deliberately send a **resolvable** literal placeholder to a third party
  (for example, config text that Kody itself will resolve later), set the
  **`x-kody-secret-resolution: off`** header on that **`fetch`**. The gateway
  strips the header and skips all placeholder resolution for that one request.
  Only the calling code can set headers, so data flowing through a URL or body
  can never disable resolution. Use this sparingly: the delivered text is still
  one resolution step away from the real secret if it later flows back through a
  secret-aware **`fetch`**.

## Host approval

If a request fails because a host is not approved for that secret, use the
approval path the error provides. Host approval lives on the dedicated
**`/connect/secrets`** page — the same kind of focused page as
**`/connect/oauth`**. A link looks like
`/connect/secrets?name=cloudflareToken&hosts=api.cloudflare.com`. When several
hosts (or several secrets) need approval together, Kody can send one link with
comma-separated **`names`** and **`hosts`**. That page lists every valid host
and approves them in one click. Values that are not hostname-shaped (a truncated
token such as `api.ope`, a path such as `api.openai.com/v1`, empty or
whitespace) are shown as invalid and are not written to the allowlist — copy the
link again if a client wrapped it.

Saving a secret does not by itself approve new hosts. Self-authored and adopted
packages do not skip this gate: an empty host allowlist blocks secret-bearing
fetch even when package read/use is automatic.

## Package approval

User-scoped secrets are available automatically for **reading and using**
(mounts, fetch placeholders, named capability lookups including `secretList`) to
packages the user authored themselves and adopted community forks. Only the
account owner can adopt, on the package settings page after a real source
review; `communityForkAdopt` returns that link and agents cannot adopt.
Unadopted community-forked packages need explicit **package** approval
(`allowed_packages`) before those read/use paths. Approval is checked against
the **stamped** package — the module that originated the call — not the
importing run. Dependents statically import the owning export; they do not need
their own grant for secrets locked to that owner. Updating or deleting a user
secret from package code (`secretSet`, `secretDelete`) always needs the grant on
the stamp package, including for self-authored and adopted packages. Only the
account owner can add a package to that grant on `/@<slug>/-/secrets/user/:name`
or `/@<slug>/-/secrets/approve`. **`secretLock`** returns an approval URL for
the owner to click (one-click Allow, same spirit as `/connect/secrets`); it does
not change `allowed_packages`. Send the link and wait. Removing a grant is also
website-only. `secretSet` cannot change `allowed_packages`. Official OAuth token
rotation (`createAuthenticatedFetch` 401 retry via `integrationTokenRefresh`)
persists host-side and does not need that write grant.

Starting **Tuesday, Oct 21, 2026**, Kody applies each user credential's
`allowed_packages` list on every package use of that credential — including when
the package is used through another package (an imported dependency) and when it
is loaded in a one-off `execute` run. Until then, publish and save may warn when
a package fills a credential whose list is non-empty and does not include that
package; publishing and saving still succeed. To fix: approve the package on the
secret's page (or via the approval link in the warning), or move the credential
use into a package that is already on the list.

**Host approval is separate and is never automatic**, including for
self-authored and adopted packages. An empty host allowlist blocks
`{{secret:name}}` fetch placeholders even when package read/use is automatic.
Saving a secret or succeeding in an ad hoc execute smoke test does not approve a
host or grant package write access.

When several secrets need the same package approved, Kody can provide a bulk
approval URL shaped like
`/@<slug>/-/secrets/approve?package_id=...&names=secretA,secretB`. That page
lists every pending secret and approves them in one click. A single-secret link
grants one package on one secret. For community forks, reviewing the source and
sending the owner the `communityForkAdopt` adoption link is an alternative to
sending those approval links. Agents and package runtimes cannot adopt.

## Package config vs package storage

Package-scoped secrets are **package config**: they are keyed by the saved
package id. They hold credentials, not application records.

Durable package data — rows, documents, checkpoints — lives in the package
storage bucket via `packageStorage()`. See
[Package state model](./packages.md#package-state-model).

## Named state

Durable facts and preferences belong in memories. Package runtime state and
knobs belong in `packageStorage()`. Versioned config belongs in a repo.
Credentials belong in secrets. OAuth client ids belong in integrations. OAuth
access and refresh tokens, and a user-registered app's client secret, live on
the integration — they do not appear in the Secrets list. PATs, API keys, and
provider-issued webhook HMAC secrets live in the secret store. GitHub-style
package-owned HMAC lives on the webhook URL record, not in the Secrets list.
