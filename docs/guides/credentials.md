---
id: credentials
title: Credentials
summary:
  What a Kody credential is and every kind it comes in (Key, OAuth, MCP server,
  URL, login, signing), how `{{secret:name}}` placeholders and scoped
  `credential(key)` clients place a value at the network boundary, how packages
  declare needs in `kody.credentials`, how callers pick between credentials with
  names and call maps, the `credential_ambiguous` / `credential_unbound` errors,
  and webhook verification. Load this when someone asks how credentials work,
  which kind to use, or why a credential did not resolve.
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
own page; see [Custom secret providers](./secret-providers.md).

Every credential has:

- **name**: yours to choose, such as `work` or `personal`. Callers pick a
  credential by name.
- **scope**: `org` (shared with the org under its Use grants) or `personal`
  (yours, granted to an org one org at a time).
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
named; query; path; and/or body). Null means anywhere. New credentials default
to headers-only. The per-request header **intersects** with that placement (it
never widens it). Distinct from **inject**, which only steers a scoped
`credential()` client. Edit fill placement on the credential detail page, via
`secretSet` / `credentialUpdate`, or the account secret editor. The gateway
fills placeholders regardless of placement and logs would-block when a fill is
outside the declared parts.

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
  is a new insert. Package runtimes still cannot set placement themselves; the
  owner can edit it on the credential detail page.

### Let app visitors use your credential

People who open an internet-visible app run it as themselves, or as no one when
they are signed out or outside your org. A signed-in member with Use can still
open org credentials they hold; everyone else cannot. To let the app use one for
every visitor, add `"ownerCredentialForVisitors": true` to that need:

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
one-time setup from ad hoc `execute` or the API, not package code (package
runtimes cannot change a credential's provider or inject). `credentialList`
returns each credential's `id`:

```ts
import { kody } from 'kody:runtime'

await kody.credentialUpdate({
	credential_id: 'cred_…',
	provider: 'anthropic',
	inject: { kind: 'header', name: 'x-api-key', format: '{value}' },
})
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

Connect the service once (your agent sends a `/connect/oauth` link). Kody keeps
the token fresh. Code looks exactly like the Key example:

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
servers to their own connect flows. The **Add credential** button on the
Credentials page opens the same form.

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

Pass a map on `execute`, for ad hoc code or an `invoke`:

```json
{
	"invoke": "kody:@you/pr-digest/summarize",
	"credentials": {
		"github": "work",
		"slack": { "name": "work", "scope": "org" }
	}
}
```

A string picks by name, and an object adds `scope` when an org and a personal
credential share a name. For a `multiple` need, an array picks several for
`credentials(key)` (`"google": ["work", "personal"]`), and `[]` picks none on
purpose. In an `invoke`, a key that no package in the run declares fails the run
with `credential_need_unknown`; ad hoc code only gets a warning. The CLI takes
the same picks:

```bash
npx @kodycodes/cli execute --invoke kody:@you/pr-digest/summarize \
  --credential github=work --credential slack=org:work
```

A pick grants nothing. It chooses only among credentials you can already Use.
Running code through a client needs your Use on the credential; a package's
identity never grants access on its own.

Defaults and trigger mappings are stored per package. Agents propose changes
with `credentialMappingPropose`; you approve them on the package's approval page
or its **Credentials** tab.

### Errors

Every credential error is structured: it has a `code`, a message, and
`retryWith`, a list of ready-to-retry picks.

| Code                         | Meaning                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `credential_unbound`         | No credential you can use matches the need                                              |
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
that org only in your own runs, through `credential(key)`; nobody else there can
use it, Owners included, and `{{secret:name}}` placeholders never resolve it.
`credentialOrgRevoke` removes the grant.

## Not available yet

- Using a personal MCP server through `credential()`. Add the MCP server to the
  org instead.
- A credential picker for visitors of a package app. Apps auto-resolve the
  signed-in visitor's single match; grant Use to the role that needs it.
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
