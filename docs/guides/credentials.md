---
id: credentials
title: Credentials
summary:
  What a Kody credential is and every kind it comes in (Key, OAuth, MCP server,
  URL, login, signing), how `{{secret:name}}` placeholders and scoped
  `credential(key)` clients place a value at the network boundary, how packages
  declare needs in `kody.credentials` (including publisher and executor
  credential needs that app visitors fill with `credential.visitor(key)`), how
  callers pick between credentials with names and call maps, the
  `credential_ambiguous` / `credential_unbound` errors, and webhook
  verification. Load this when someone asks how credentials work, which kind to
  use, or why a credential did not resolve.
category: platform
---

# Credentials

A credential is anything Kody uses to reach a service for you: an API key, an
OAuth connection, an MCP server, a webhook URL, a username and password, or a
signing key. Credentials belong to an org (or to you, as personal credentials)
and show up together on your org's **Credentials** page.

One rule holds for every kind: **a credential's value never enters package code
or your code.** Code names a credential. Kody puts the value into the outgoing
request at the network boundary, only for the hosts that credential allows, and
only over HTTPS. Agents, packages, logs, and tool output never see it. The one
thing code can get back is a signature from a signing credential: a token
derived from the key, never the key. Treat it like any other bearer token.

## The kinds

| Kind       | What it holds                                                | How code uses it                                           |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Key        | An API key, personal access token, or webhook signing secret | `{{secret:name}}` placeholders, or `credential(key).fetch` |
| OAuth      | A connection you signed in to (GitHub, Google, Slack, …)     | `credential(key).fetch`, or `{{integration-token:name}}`   |
| MCP server | A remote MCP server connection                               | `credential(key).callTool`                                 |
| URL        | A whole secret URL (a chat webhook, a `/bot<token>` base)    | `credential(key).fetch` with a relative path               |
| Login      | Login fields Kody exchanges for a session token              | `credential(key).fetch`                                    |
| Signing    | A signing secret or private key                              | `credential(key).sign`                                     |

Secrets (the Key kind) and integrations (the OAuth kind) are both credentials.
The kind names in manifests and APIs are `secret`, `oauth`, `mcp`, `url`,
`login`, and `signing`.

Custom secret providers (vaults such as 1Password) are not a credential kind.
Granting Kody access to a vault is a separate trust decision, so they have their
own page; see [Custom secret providers](./secret-providers.md). A saved package
declares a provider it uses with a `kind: "secret-provider"` need (see
[Use a provider in a saved package](./secret-providers.md#use-a-provider-in-a-saved-package)).
No saved credential ever fills that need.

Every credential has:

- **name**: yours to choose, such as `work` or `personal`. Callers pick a
  credential by name.
- **scope**: who owns it, seen from the run's org. `org` means the run's org
  owns it: every Key, login, OAuth connection, or MCP server stored in that org
  reads `org`, including a credential saved with `secretSet({ scope: 'user' })`
  and a Key bound to the package. `personal` means it is the caller's own
  personal credential, stored in their personal org and granted to this org one
  org at a time. In your personal org, your own credentials read `org`. See
  [Scope in code](#scope-in-code).
- **provider**: an optional slug such as `github`. Package needs match on it.
- **hosts**: the only hosts the value may be sent to, over HTTPS. Hosts live on
  the credential, never in a package manifest, so publishing or forking a
  package cannot widen them.
- **inject** (Keys used through `credential()`): where the value goes, a header,
  Basic auth, or a query parameter. The default is
  `Authorization: Bearer {value}`.

## Keys and placeholders

A Key is a saved secret. Write `{{secret:name}}` anywhere in a `fetch` request:
a header, the URL path or query, or a text body. When the request leaves Kody,
the gateway checks it and fills in the value.

> [!DIAGRAM] placeholder-fill Your code sends `{{secret:github}}`. The Kody
> gateway checks that the request is HTTPS and goes to a host the credential
> allows, swaps in the value, and redacts the value if the response echoes it
> back.

```ts
const response = await fetch('https://api.github.com/user/repos', {
	headers: { Authorization: 'Bearer {{secret:github}}' },
})
```

For a webhook URL (Slack, Discord, and similar), keep the path prefix literal
and put only the one-segment token in the secret:

```ts
await fetch('https://hooks.example.com/services/{{secret:webhookToken}}', {
	method: 'POST',
	body,
})
```

A path placeholder is filled as one encoded segment, so a `/` inside the secret
becomes `%2F` and cannot change the route. The MCP reference has the full rule:
[Secrets and host approval](../use/secrets-and-values.md#placeholders-in-fetch).

- The request must be HTTPS and its host must be one you approved for that
  secret. Otherwise it is refused with an error naming the secret and host; a
  placeholder is never sent unfilled.
- You approve a Key's hosts on the approval link your agent sends
  (`/connect/secrets`). A Key with no approved hosts sends nowhere.
- To change a Key's or an OAuth connection's hosts later, open it on the
  Credentials page and choose **Edit hosts**. Enter host names only (such as
  `content.dropboxapi.com`); Kody sends credentials only over HTTPS, with no
  wildcards, ports, or paths. An OAuth connection always keeps its API base and
  token hosts; a connection to a built-in app keeps the hosts Kody sets for it.
  Each change is recorded in the org audit log. Agents cannot edit hosts.
- If the remote service echoes the value back, the gateway replaces it with
  `[REDACTED SECRET]` before your code reads the response.
- `{{integration-token:name}}` works the same way for an OAuth connection, on
  the integration's own hosts.

The gateway fills those placeholders in the **body** too, not only in headers.
Text this package did not write — a user message, an issue body, a comment — can
quote `{{secret:name}}`. On a host that credential allows, the real value is
sent. If that name is not saved, the fetch fails with
`Secret "name" was not found`. When the body forwards someone else's text, set
`x-kody-secret-resolution: headers-only` so only headers are filled:

```ts
await fetch('https://api.github.com/repos/acme/widgets/issues', {
	method: 'POST',
	headers: {
		Authorization: 'Bearer {{secret:github}}',
		'content-type': 'application/json',
		'x-kody-secret-resolution': 'headers-only',
	},
	body: JSON.stringify({ title: 'Widget broke', body: userReport }),
})
```

`off` sends every placeholder as written, including headers. Kody strips the
header before the request leaves. `kody dev check` and a successful publish
print a warning for a clear case: a fetch (or `new Request`) whose init object
is a literal, whose body is not a literal (or `JSON.stringify` /
`new URLSearchParams` of literals), and whose headers do not set
`x-kody-secret-resolution` to `headers-only` or `off`. That includes helpers
that build headers in a variable and header spreads — the scanner cannot see
`headers-only` on those bags. Variable whole-`init` values (`fetch(url, init)`)
are still skipped. The warning does not fail the check or block publish.

Each credential also stores an allowed **fill placement** (headers, optionally
named; query; path; and/or body). New credentials default to headers-only. The
per-request header **intersects** with that placement (it never widens it).
Distinct from **inject**, which only steers a scoped `credential()` client. Edit
fill placement on the credential detail page, via `secretSet` /
`credentialUpdate`, or the account secret editor.

The fetch gateway enforces placement: a fill into a part the credential does not
allow is refused with a message naming the credential, the refused part, and the
allowed parts. Query, URL path, and body also need the owner's opt-in, given by
saving them on the credential page, which warns that the host may store a value
sent there. A credential that already filled query, path, or body keeps those
parts without a new save. Older credentials with no placement set fill headers
plus those parts.

Agents cannot widen placement, but they can ask the owner to. A refused query,
path, or body fill of a user Key carries a ready approval link,
`/connect/secrets?name=<key>&placement=body` (add `&hosts=<host>` to approve the
host in the same click). The owner sees the credential, the requested part, and
the "host may store this" warning, then approves or declines. Agents can build
the same link with `credentialPlacementApprovalLink` (MCP `api`, or
`kody api credentialPlacementApprovalLink --params '{"name":"plaidSecret","parts":["body"],"hosts":["production.plaid.com"]}'`),
which never changes placement itself. Other refusals link to the credential's
fill placement setting (`/@<org>/-/credentials/<credential>#fill-placement`).

Full placeholder rules (encodings, multipart, the inert `{{secret:<name>}}`
mention form):
[Secrets and host approval](../use/secrets-and-values.md#placeholders-in-fetch).

## Scoped clients: `credential(key)`

With a placeholder, the code decides where the value goes. With a scoped client,
the **credential** decides: its hosts and inject rule say where the value is
placed, and it is never placed in a request body. Code gets a client that holds
an opaque handle, not a value.

```ts
import { credential } from 'kody:runtime'

const github = await credential('github')
const response = await github.fetch('https://api.github.com/user/repos')
```

The client has `name`, `scope`, `kind`, and `hosts`, plus one of:

- `fetch` for Key, OAuth, URL, and login credentials,
- `callTool` for MCP servers,
- `sign` for signing credentials.

A relative URL resolves against the credential's first exact host. An absolute
URL must be on one of its hosts. If code sets the header the credential injects,
the credential's value replaces it. Redirects are followed by the client, and
the credential only travels to its own hosts. A 401 or 403 response carries an
`x-kody-credential-hint` header naming the inject shape (for example
`header Authorization Bearer`), never the value.

`credentials(key)` returns an array of clients for a need declared with
`multiple: true`.

### Scope in code

`client.scope` uses the same two values as `credentialList` and call maps: `org`
or `personal`, relative to the run's org. `secretSet` and `secretList` use a
different word, the storage scope (`user`, `package`, or `session`), which says
where a Key is stored, not whose it is. A `user`-scope Key is an owner-level Key
of the org it was saved in, not a personal credential.

| Credential                                                                   | `secretList` scope            | `client.scope`                 |
| ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------ |
| Key saved with `secretSet({ scope: 'user' })` in the run's org               | `user`                        | `org`                          |
| Key saved with `secretSet({ scope: 'package' })` for the running package     | `package`                     | `org`                          |
| OAuth connection or MCP server in the run's org                              | not listed                    | `org`                          |
| Your `user`-scope Key in your personal org, run in your personal org         | `user`                        | `org`                          |
| Your `user`-scope Key in your personal org, granted to and run in a team org | `user` (in your personal org) | `personal`                     |
| Key saved with `secretSet({ scope: 'session' })`                             | `session`                     | never opened by `credential()` |

Most package code should not branch on `scope`. Kody already picked the
credential and checked that the run may use it, and both scopes fetch the same
way. Use it for labels, logs, or results that say whose account was used:

```ts
import { credential } from 'kody:runtime'

export default async function checkPortal() {
	const login = await credential('portal')
	// Do not refuse a login because scope is 'org': a credential saved with
	// secretSet({ scope: 'user' }) in the run's org reads 'org'.
	const response = await login.fetch('/api/me')
	return {
		account: login.scope === 'personal' ? `${login.name} (yours)` : login.name,
		ok: response.ok,
	}
}
```

To require one specific credential, declare the need with a `provider` and
`kind`, and let the caller map it by `{ name, scope }` (see
[Picking a credential](#picking-a-credential)) instead of checking `scope` in
code.

### Declare needs in `kody.credentials`

A package lists the credentials it needs in `package.json`. Each need has a
provider (which defaults to the key) and a required description that tells the
person choosing a credential why the package wants it.

```json
{
	"name": "@you/pr-digest",
	"exports": { "./summarize": "./src/summarize.ts" },
	"kody": {
		"description": "Summarize open pull requests every morning.",
		"credentials": {
			"github": { "description": "Read pull requests to summarize them" },
			"slack": { "description": "Post the summary to a channel" }
		}
	}
}
```

`kind` is optional. Without it, any credential for that provider that can make
requests matches: a Key such as a personal access token, an OAuth connection, or
a login. `credential('github')` picks the right path for whichever one is used
(placing the Key's header, refreshing an OAuth token once on a 401, or running
the login exchange), so the package code is identical for a PAT and for OAuth.

Declare `kind` only when the package needs a specific shape:

```json
"credentials": {
	"github": { "description": "Read pull requests to summarize them" },
	"apple-music": { "kind": "signing", "description": "Sign developer tokens" },
	"linear": { "kind": "mcp", "description": "Create issues for failing checks" },
	"alerts-bot": { "kind": "url", "provider": "telegram", "description": "Post alerts" },
	"google": { "kind": "oauth", "multiple": true, "description": "Calendars to include" }
}
```

- `signing` for `sign()`, `mcp` for `callTool()`, `url` for a whole-URL secret,
  or `oauth` when the provider only works through OAuth (Google user data, for
  example).
- A second account from the same provider gets its own key with an explicit
  `provider`.
- Needs have no hosts or inject fields (those belong to the credential). An
  optional `placement` on a need is the reviewable default for package-scope
  secrets that need inserts as that name (Connect / `secretSet` when no row
  exists yet), instead of headers-only. Disconnect clears the value but keeps
  the row and placement; reconnect fills the same record so placement wins over
  the manifest default. Delete removes the credential entirely; a later Connect
  is a new insert. Package runtimes cannot set placement themselves; the owner
  can edit it on the credential detail page.

### Choose who supplies a package credential

When the `package-credential-suppliers` flag is on, a need can declare
`supplier: "publisher"` or `supplier: "executor"`. A publisher need is set by
the package publisher with an org-level mapping. It cannot be set by a
per-person or per-trigger mapping, and a visitor cannot resolve it from their
own credentials. An app uses it with `credential("key")`.

An executor need is chosen by each person who uses the app. Its consent scope is
`need:<key>`. The app resolves only the credential IDs selected for that need in
that person's live Sign in with Kody grant. It does not fall back to the
publisher's credentials, the visitor's personal defaults, or automatic matching.
A mapped credential is rechecked for live Use access on every call.

`kody.credentials` is where a credential need and its supplier are declared. An
executor need gets its own `need:<key>` consent scope from that declaration and
needs no `kody.app.visitorNeeds` entry. A `kody.app.visitorNeeds` entry whose
`credential` names an executor need is accepted as an alias for it; it cannot
name a publisher need. Use `kody.app.visitorNeeds` for capability needs.

In app code, open an executor need with `credential.visitor("key")`. Plain
`credential("key")` never reads the visitor's pick. Inside an app it is refused
with `credential_denied`, naming `credential.visitor`. In a direct run (execute,
a job, or another package calling it) the person running it is the executor, so
`credential("key")` resolves their own credentials.

To check whether the flag is on for an org, call `packageGet` on one of its
packages: `credentials.suppliersEnabled` is `true` when it is. While it is
`false`, `supplier` and `required` are ignored and needs resolve without a
supplier.

Executor needs default to required. Set `required: false` to make a need
optional. Required needs cannot be skipped in consent, and the app does not
serve until the visitor has connected a usable credential. A direct run that
cannot resolve a required executor need fails before execution with
`credential_required`, naming the need. Inside an app, an executor need without
its grant mapping fails with `credential_unbound`; it never falls back to the
publisher's credential. `required` is valid only for executor-supplied needs.
The older `ownerCredentialForVisitors: true` setting keeps its meaning as a
publisher-supplied alias. A need with no supplier keeps the existing package
behavior.

### Let app visitors use your credential

People who open an internet-visible app run it as themselves, or as no one when
they are signed out or outside your org. A signed-in member with Use can still
open org credentials they hold; everyone else cannot. Executor needs are the
exception while the `package-credential-suppliers` flag is on: any signed-in
visitor, inside or outside your org, can pick one of their own credentials for
an executor need on the consent screen
([above](#choose-who-supplies-a-package-credential)). After Allow, a visitor
outside your org gets a short-lived visit pass that only opens the executor
credentials they approved, through `credential.visitor(key)`. Storage,
capabilities and everything else still treat them as an anonymous visitor plus
identity. To let the app use one for every visitor, add
`"ownerCredentialForVisitors": true` to that need:

```json
"credentials": {
	"rooms-db": {
		"kind": "secret",
		"description": "Database the room chart reads for every visitor",
		"ownerCredentialForVisitors": true
	}
}
```

The approval page then says that visitors can use that credential through the
app, signed out or signed in as someone else, without seeing its value. After
you approve, the app's `credential('rooms-db')` resolves with the approving
owner's access for each visitor, limited to the credentials approved for that
need. Other needs and placeholders still act as the visitor. Visitor use is
rate-limited and recorded in the org activity log with who used it. See
[Packages](../use/packages.md#let-app-visitors-use-the-owners-credential).

## Each kind through `credential()`

### Key

Any saved Key can be used through a client. Set its provider so needs match it,
and its inject if the service does not take `Authorization: Bearer`. This is
one-time setup on the credential's page on the website, or with the MCP `api`
tool (`credentialUpdate`). Changing inject or widening placement is refused from
`execute` (hosted or `--local`), package, and app code, with a link to the
credential's page; narrowing placement and setting the provider still work
there. `credentialList` returns each credential's `id`:

```json
{
	"operationId": "credentialUpdate",
	"params": {
		"credential_id": "cred_…",
		"provider": "anthropic",
		"inject": { "kind": "header", "name": "x-api-key", "format": "{value}" }
	}
}
```

```ts
import { credential } from 'kody:runtime'

const anthropic = await credential('anthropic')
const response = await anthropic.fetch(
	'https://api.anthropic.com/v1/messages',
	{
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({ model, max_tokens: 512, messages }),
	},
)
```

The inject options are `{ kind: 'header', name, format }` (the format holds
`{value}` once), `{ kind: 'basic', valueAs: 'password', other: 'api' }` (the
value is the password and `other` is a literal username, or the reverse), and
`{ kind: 'query', param }`. The same Key keeps filling `{{secret:name}}`
placeholders; inject and provider only affect clients.

### OAuth

Connect the service once (your agent sends a `/connect/oauth` link, with
`org=<slug>` for a team organization). Kody keeps the token fresh. Code looks
exactly like the Key example:

```ts
const github = await credential('github')
const response = await github.fetch('https://api.github.com/user')
```

On a 401 the client refreshes the token and retries once. OAuth connections
always use `Authorization: Bearer`. `createAuthenticatedFetch` and
`{{integration-token:name}}` also resolve the same OAuth connection.

### MCP server

An MCP server you added to the org is a credential with `callTool`:

```ts
const linear = await credential('linear')
const result = await linear.callTool('create_issue', {
	title: 'Nightly build failed',
	teamId: 'ENG',
})
```

The need must declare `kind: "mcp"`. Set the server's provider with
`credentialUpdate` so it auto-resolves.

### URL

For services whose secret is the URL itself, such as a Telegram bot
(`https://api.telegram.org/bot<token>`) or a chat webhook. Code passes only a
path and query; Kody appends them to the stored URL.

```ts
const alerts = await credential('alerts-bot')
await alerts.fetch('/sendMessage', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ chat_id: chatId, text: 'Deploy finished' }),
})
```

The stored URL must be HTTPS and on one of the credential's hosts. A path cannot
name another origin or climb out of the stored path. A URL client returns
redirects as they are instead of following them.

### Login

For services that trade a username and password for a session token. Kody stores
the login fields, runs the exchange itself, and places only the session token
(in a header by default, or a query parameter). The login response never reaches
code.

```ts
const reports = await credential('acme-reports')
const response = await reports.fetch('https://api.acme.example/v1/reports')
```

The credential's `login_exchange` says how to log in: the exchange `url` (on one
of the credential's hosts), `bodyFormat` (`json` or `form`), a `body` template
where `{field}` is replaced by a login field, and `tokenPath`, the dot path to
the token in the JSON response.

A login also keeps a refresh token. The value holds the token as a field, and
the exchange is the token request:

```ts
await kody.secretSet({
	name: 'token-demo',
	scope: 'user',
	kind: 'login',
	hosts: ['auth.example.com', 'api.example.com'],
	value: JSON.stringify({ refresh_token: '<refresh token>' }),
	login_exchange: {
		url: 'https://auth.example.com/oauth/token',
		bodyFormat: 'form',
		body: {
			grant_type: 'refresh_token',
			client_id: '<client id>',
			refresh_token: '{refresh_token}',
		},
		tokenPath: 'access_token',
		expiresInPath: 'expires_in',
		refreshToken: { path: 'refresh_token', field: 'refresh_token' },
	},
})
```

Body values without a `{field}` token (`grant_type`, `client_id`) are sent as
written. Without `expiresInPath`, a session lasts `ttlSeconds` (default 3600, at
most 24 hours). The session goes in an `Authorization: Bearer` header unless the
credential's `inject` says otherwise. The package declares the need with
`"kind": "login"` in `kody.credentials` and calls
`(await credential('token-demo')).fetch('https://api.example.com/v1/items')`; it
never sees the refresh token or the access token. The owner creates or rotates
the credential on the website or with `secretSet` outside a package: package
code cannot set `kind`, `hosts`, or `login_exchange`.

`refreshToken` is for providers that rotate refresh tokens: `path` is where the
response carries the new one, and `field` is the login field it replaces (a
field the body sends). When the response has a new one, Kody saves it in place
of the old one together with the new session, only if the credential did not
change meanwhile, and records a value replacement in the audit log without the
value.

What Kody keeps: the session, encrypted, for this credential and its current
value, exchange, hosts, and inject, until it expires (the 30 second early margin
included). Every isolate reuses it, and only one exchange runs at a time per
credential, so a rotating provider never sees the same refresh token twice.
Editing the value, exchange, hosts, or inject, or deleting the credential, drops
it. When one of the credential's hosts answers 401 to a request without a body,
Kody drops the session, runs the exchange once more, and retries the request
once (with the same host and placement checks). A request with a body is
returned as is.

A refresh token that a token request in an execute run returned sealed
(`kody-sealed.…`) can become a login credential without code reading it: pass it
as `sealed_token` together with `login_exchange`, as in
`secretSet({ name: 'token-demo', scope: 'user', sealed_token: tokens.refresh_token, login_exchange })`.
Kody opens it on the host and stores it as the login field the body sends
(`refreshToken.field`, or `refresh_token`). The credential's hosts are the
sealed token's save hosts, and the exchange URL must be one of them. This works
from execute in the run that minted the token, not from package code.

Moving a package off a package-scoped refresh secret and a stored access token:

1. Declare the need in `kody.credentials` with `"kind": "login"`, and replace
   the package's token handling with `credential('<key>').fetch(...)`.
2. The owner creates the login credential on the website, or with `secretSet`
   outside a package (`value` holding the refresh token field, or a
   `sealed_token` from a token request in the same execute run, so no code reads
   the value), and maps it to the need.
3. Publish, check a request works, then delete the old package secrets (the
   refresh token and the stored access token) with `secretDelete`.

Limits: the exchange sends only `content-type` and `accept` headers. Package
code cannot save the sealed `access_token` from its own token request as a Key
(`sealed_token` saving works from execute only); without a login credential, use
the sealed token in the run that minted it and mint it again next run.

### Signing

For APIs that want a signed JWT or an HMAC. Code gets the signature, never the
key. Declare `kind: "signing"` for JWT key material. HMAC also works through
`sign({ type: "hmac", ... })` on an ordinary Key (`secret`) — the same Key a
webhook `verification.secretName` already uses — so you do not need to re-kind a
webhook consumer secret as `signing`.

```ts
const appleMusic = await credential('apple-music')
const token = await appleMusic.sign({
	type: 'jwt',
	algorithm: 'ES256',
	header: { kid: keyId },
	claims: { iss: teamId, iat: now, exp: now + 3600 },
})
await fetch('https://api.music.apple.com/v1/catalog/us/songs/203709340', {
	headers: { Authorization: `Bearer ${token}` },
})
```

```ts
const signature = await partner.sign({
	type: 'hmac',
	algorithm: 'hmac-sha256',
	message: body,
	encoding: 'hex',
	prefix: 'sha256=',
})
```

JWTs support `RS*`, `PS*`, `ES*`, `EdDSA` (PKCS#8 PEM private keys), and `HS256`
/ `HS384` / `HS512`. Kody signs only for one of the credential's hosts; pass
`host` to pick one, or it uses the first exact host.

## Creating credentials

Your agent sends a creation link, and you paste the value into the page, never
into chat. Links carry your org in the path:

```txt
https://kody.codes/@acme/-/credentials/new?kind=url&name=alerts-bot&provider=telegram&allowedHosts=api.telegram.org
```

`kind` preselects a kind; add `kindMode=required` to lock it. `name`,
`provider`, `description`, and `allowedHosts` prefill the form. The page saves
Key, URL, login, and signing credentials in place, and hands OAuth and MCP
servers to their own connect flows.

The **Add credential** button on the Credentials page opens the page without a
link. It leads with **Copy prompt**, a short prompt you paste into your agent so
it works out the kind, name, and hosts and hands back a prefilled link. **Create
one manually** opens the same form in place. A link with any prefill skips
straight to the form.

On that form, **Which packages can read it** is **Any package in this org** (the
default) or **Only these packages**, which locks the credential to the packages
you pick (`allowedPackages`). A key that belongs to one package is made from
that package's own **Credentials** tab (**Add a key only this package can
read**), or from a link that names the package (`scope=package&packageId=...`).

Code that already holds a value (a key the package just minted) can store it
with `secretSet`, which also takes `kind`, `hosts`, `login_exchange`,
`provider`, and `inject`. Whoever supplies a value decides where it may go, so
`kind` and `hosts` are set together with the value.

## Picking a credential

You can have several credentials for the same provider, such as `work` and
`personal`. When code calls `credential(key)`, Kody uses the first of these that
applies:

1. The caller's credentials map for this run.
2. A stored mapping for the trigger that started the run.
3. Your default mapping for the package, then the org's default.
4. The one credential you can Use that matches the need.

Kody never guesses between two matches. Zero matches is `credential_unbound` and
two or more is `credential_ambiguous`.

Pass a map on `execute` next to its `code`:

```json
{
	"code": "import action from 'kody:@you/pr-digest/summarize'\nexport default (params) => action(params)",
	"credentials": {
		"github": "work",
		"slack": { "name": "work", "scope": "org" }
	}
}
```

A string picks by name, and an object adds `scope` when an org and a personal
credential share a name. For a `multiple` need, an array picks several for
`credentials(key)` (`"google": ["work", "personal"]`), and `[]` picks none on
purpose. On `execute`, a key that no package in the run declares gets a warning,
not a failure. The CLI takes the same picks (`--invoke` writes the passthrough
for you):

```bash
npx @kodycodes/cli execute --invoke kody:@you/pr-digest/summarize \
  --credential github=work --credential slack=org:work
```

A pick grants nothing. It chooses only among credentials you can already Use.
Running code through a client needs your Use on the credential; a package's
identity never grants access on its own.

Defaults and trigger mappings are stored on the package you run (the entry
package), including needs it inherits from its dependencies. When a dependency
calls `credential(key)` in that run, it uses the entry package's mappings (the
first entry that has the need when one run has several, and a caller that is
itself an entry uses its own), and a creation link names the entry package. A
mapping stored on the dependency applies only when you run the dependency
itself. Agents propose changes with `credentialMappingPropose`; you approve them
on the package's approval page or its **Credentials** tab.

To build one shared package that many callers use with their own accounts, see
[Shared packages for many accounts](./shared-packages.md).

A Key bound to one package fills only that package's own `credential()` calls,
so map an org or personal credential for a need the entry package inherits.

### Errors

Every credential error is structured: it has a `code`, a message, and
`retryWith`, a list of ready-to-retry picks.

| Code                         | Meaning                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `credential_unbound`         | No credential you can use matches the need                                              |
| `credential_required`        | A required executor need has no connected credential before a direct run                |
| `credential_ambiguous`       | More than one matches; `options` lists them by name/scope                               |
| `credential_not_found`       | The named credential is missing or not usable by you                                    |
| `credential_need_unknown`    | The map names a key no package in the invoked run declares                              |
| `credential_need_undeclared` | A package someone else runs uses a credential it does not declare in `kody.credentials` |
| `credential_denied`          | Authorization failed                                                                    |
| `credential_rate_limited`    | An app's visitors used an owner's credential too often; try again shortly               |
| `host_not_allowed`           | The request's host is not one of the credential's hosts                                 |
| `insecure_transport`         | The request is not HTTPS                                                                |

When a need has no usable credential, or more than one, the error carries
`createUrl`: a link to the creation page prefilled for that need, so an agent
can hand you a link instead of a bare error. A name that matches nothing
(`credential_not_found`) carries one too.

```ts
try {
	const github = await credential('github')
} catch (error) {
	if (error.code === 'credential_ambiguous') {
		// error.options: [{ name: 'work', scope: 'org', … }, { name: 'personal', … }]
		// error.retryWith: [{ credentials: { github: { name: 'work', scope: 'org' } } }, …]
	}
	if (error.code === 'credential_unbound') {
		// error.createUrl: https://kody.codes/@acme/-/credentials/new?provider=github&…
	}
	throw error
}
```

`credential.named(name)` picks by exact name in ad hoc code and in unshared
packages in your personal org. Shared packages declare needs instead.

## Webhook verification

Inbound webhooks verify the sender before any package code runs. Declare it on
the webhook in `kody.webhooks`.

A provider that signs deliveries with a signing secret it issued (Sentry,
Stripe) uses a Key named by `secretName`:

```json
"verification": {
	"type": "hmac-sha256",
	"header": "sentry-hook-signature",
	"secretName": "sentryWebhookSecret",
	"encoding": "hex"
}
```

Omit `secretName` for GitHub-style hooks where Kody mints the signing secret
onto the webhook URL itself. A sender that cannot sign uses the secret path
segment of the minted URL as its credential:

```json
"verification": { "type": "url-secret" }
```

Treat a minted webhook URL like any other credential. Details:
[Inbound webhooks](../use/webhooks.md).

## Personal credentials

A Key, OAuth connection, or MCP server in your personal org is a personal
credential. Grant it to a team org with `credentialOrgGrant`. It then works in
that org only in your own runs: through `credential(key)`, through
`{{secret:name}}` and `{{integration-token:name}}` placeholders, and through
`createAuthenticatedFetch(name)`. An org credential with the same name wins
first. Nobody else there can use it, Owners and Automation included.
`credentialOrgRevoke` removes the grant.

When a team org has registered an OAuth app, each Member can connect their own
account through it (**Connect your own account** on the app's page, or
`/connect/oauth?org=<org>&app=<app>&mode=personal`). The connection is yours and
lives in your personal org, but it is pinned to that org: it is granted there
automatically, can never be granted anywhere else, and works only in your own
runs in that org. The org's client secret stays with the org. Org Owners can see
who connected (member, account label, date) and revoke a connection, but never
use it or read its tokens. Revoking, leaving the org, or deleting the app wipes
it and revokes it with the provider where the provider supports that. See
[OAuth](./oauth.md#connect-your-own-account-through-an-orgs-app).

## Limits

- Using a personal MCP server through `credential()`. Add the MCP server to the
  org instead.
- A `verify` operation on signing credentials for inbound webhooks. Keys verify
  webhooks.
- Declaring OAuth scopes on a need. A missing scope shows up as a 401 or 403
  with `x-kody-credential-hint`.

## Leftover secret mounts

Older packages declared `kody.secretMounts` and read them with
`packageSecrets.get`. That call returns an opaque `{{secret:…}}` ref. A
dependent that statically imported the package bundled that call. The bundled
copy still resolves the alias against the dependency's **current** published
manifest, not the commit it was built from.

Publish may keep those mount declarations when the package's own source uses
`kody.credentials` and does not call `packageSecrets.get`. Keeping a mount is a
compatibility lane for those stale bundles. It grants nothing new:

- Resolution still reads only the mounts on the current manifest. There is no
  alias fallback, no history of old mounts, and no commit-pinned lookup.
- The mounted secret **name** must also be a `kody.credentials` slot of kind
  `secret` or `signing` (or a slot with no kind). The alias is not a stamp key.
  A kept mount whose name is not declared fails closed
  (`credential_need_undeclared`) once the package has a credential stamp. A
  `package` or `session` scope on the mount does not skip that check.
- Actor Use, package approval, and a fresh secret lookup still run. Deleting the
  secret cuts off old code on its next call. Old code cannot keep using a
  deleted secret.
- New source that calls `packageSecrets.get` or `packageSecretGet` still fails
  the publish gate. A newly published dependent cannot borrow the dependency's
  mount: its own `packageSecrets.get` runs as the dependent, which does not
  declare that mount.

The credentials check says which aliases were kept. Publish results,
`static_dependents`, locked-publish approval, and the approve-publish page name
the stale static dependents that still read each mount. They also warn when a
publish **removes** an alias those dependents bundled: removing the mount or
deleting the secret will break those named packages.

Retire a mount only after `static_dependents` shows no stale bundle still
calling `packageSecrets.get` for it (dependents republish onto the credential
slot). Then delete the mount. Deleting the underlying secret is the other
revocation lever and works even while the mount declaration remains.

## Where to go next

- [Secrets](./secrets.md): the Key kind in depth, host and package approval, and
  expiry.
- [Secrets and host approval](../use/secrets-and-values.md): MCP-level reference
  for placeholders, `secretSet` fields, and personal grants.
- [Packages](../use/packages.md): the full `kody.credentials` and `credential()`
  reference.
- [OAuth](./oauth.md) and [MCP servers](../use/mcp-client-servers.md): connect
  each kind.
- [ADR 0068](../contributing/decisions/0068-credentials-own-placement-scoped-clients.md):
  the design record for the credentials model.
