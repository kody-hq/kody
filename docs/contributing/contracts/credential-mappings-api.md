# Credential mappings, approval, and creation links contract

Contract between the non-UI half (data model, APIs, runtime errors) and the UI
half (creation one-pager, credentials list, package Credentials / Default
mappings / Triggers tabs, approval page). It builds on
[ADR 0068](../decisions/0068-credentials-own-placement-scoped-clients.md),
including the 2026-10-12 amendments and the
[credential mappings amendment](../decisions/0068-credentials-own-placement-scoped-clients.md#amendment-2026-10-13-credential-mappings).

"Credentials" is the umbrella term: Keys (secrets), OAuth integrations, MCP
servers, and the opt-in `url`, `login`, and `signing` kinds are all credentials.

Shapes here are the API contract. The TypeScript types and URL codecs live in
[`credential-contracts.ts`](../../../packages/worker/universal/credential-contracts.ts)
so the client and the server import the same definitions; its test holds sample
payloads for UI fixtures.

## Rules every surface keeps

- No surface returns, logs, or displays a credential value.
- A mapping never grants anything. A run still needs the actor's Use on the
  mapped credential (plus `package:execute`), checked at run time.
- Every option list holds only credentials the viewer can Use.
- Agents can only **propose** mappings. A proposal takes effect only when a
  signed-in person clicks Approve on the approval page.
- Key placeholders (`{{secret:NAME}}`, `{{integration-token:NAME}}`) resolve by
  name and do not use mappings.
- Hosted and `--local` runs resolve mappings the same way (the host resolves;
  values never reach the local machine).

## Vocabulary

| Term              | Meaning                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Need              | One key of a package's `kody.credentials` closure (`key`, optional `kind`, `provider`, `description`, `multiple`).                                                 |
| Credential ref    | `{ id, name, scope, kind }`. `scope` is `org` (owned by the org) or `personal` (the viewer's own credential granted to this org).                                  |
| Mapping           | The ordered credential refs chosen for one need. `[]` means "none on purpose". At most one ref unless the need is `multiple` (then at most 16).                    |
| Default mapping   | A package's ad hoc default for one need. Two layers: `org` (set by a package manager, org credentials only) and `mine` (the viewer's own override).                |
| Trigger instance  | One declared trigger of a package as one person runs it: a schedule (`cron`, `kody.jobs`), a `subscription` topic, or a minted `webhook`. Backed by an enablement. |
| Trigger mapping   | A per-instance override for one need. A need with no override inherits the enabler's default mapping.                                                              |
| Effective mapping | What a run would use for a need right now, with where it came from.                                                                                                |

## Resolution order

For `credential(key)` in a package run, the first step that yields a mapping
wins:

1. **Call map** entry (`credentials` on `execute` / `packageInvoke` / the CLI;
   interactive runs only, see #3599).
2. **Trigger mapping** of the enablement the run acts as (trigger runs only).
3. **Default mapping**, `mine` layer, then `org` layer.
4. **Auto-resolve**: exactly one candidate (ADR 0068 resolution rule 3).

Unusable refs:

- In a trigger mapping, a ref the enabler has lost Use on (deleted, Use revoked,
  personal grant removed), or that no longer fits the need's kind or provider,
  pauses the enablement before the run (`credential_access` on the Waiting list)
  instead of failing mid-run with `credential_not_found`. It never falls through
  to another credential. The next event resumes once every named credential is
  usable again (see
  [Paused on a trigger mapping](#paused-on-a-trigger-mapping)).
- In a default mapping, refs the actor cannot Use are skipped; a layer with no
  usable ref counts as absent and resolution continues with the next step. This
  keeps an org default to a shared bot credential from breaking members who lack
  Use on it while still letting them auto-resolve their own.
- `[]` at any step stops resolution: the need is unbound on purpose
  (`credential_unbound`, with a creation link).

## Shared types

```ts
export const credentialKinds = [
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] as const
export type CredentialKind = (typeof credentialKinds)[number]
export type CredentialScope = 'org' | 'personal'

export type CredentialRef = {
	id: string
	name: string
	scope: CredentialScope
	kind: CredentialKind
}

/** A pick as an agent or a form sends it: by name (optionally scoped) or id. */
export type CredentialPick =
	{ name: string; scope?: CredentialScope } | { id: string }

export type CredentialMappingLayer = 'org' | 'mine'

export type CredentialTriggerKind = 'cron' | 'subscription' | 'webhook'
export type CredentialTriggerRef = {
	kind: CredentialTriggerKind
	name: string
}

export type StoredCredentialMapping = {
	/** `[]` is "none on purpose". */
	credentials: Array<CredentialRef>
	/** Refs the viewer can no longer Use (deleted or Use revoked); ids only. */
	unusableIds: Array<string>
	updatedAt: string
	updatedBy: { username: string } | null
}

export type CredentialMappingSource =
	'call' | 'trigger' | 'mine' | 'org' | 'auto' | 'none'

export type EffectiveCredentialMapping = {
	source: CredentialMappingSource
	/**
	 * - `ready`: a run would use `credentials`.
	 * - `none`: mapped to `[]` on purpose; the need is unbound.
	 * - `unbound`: nothing mapped and no candidate.
	 * - `ambiguous`: nothing mapped and several candidates (`candidates`).
	 * - `unusable`: a trigger mapping names a credential the enabler cannot Use.
	 */
	status: 'ready' | 'none' | 'unbound' | 'ambiguous' | 'unusable'
	credentials: Array<CredentialRef>
	candidates: Array<CredentialRef>
	/** Absolute creation link; set when status is not `ready`. */
	createUrl: string | null
}

export type CredentialMappingTarget =
	| { type: 'default'; layer: CredentialMappingLayer }
	| { type: 'trigger'; trigger: CredentialTriggerRef }

export type CredentialMappingChange = {
	target: CredentialMappingTarget
	needKey: string
	/** `null` clears the override (inherit); `[]` is "none on purpose". */
	credentials: Array<CredentialPick> | null
}
```

## Credential creation link

```
GET /@<org>/-/credentials/new?kind=<kind>&kindMode=hint|required&...
```

Agents hand people this org-scoped link (organization in the URL segment; no org
picker on the page). Runtime errors build it when the run's org is known (see
[Runtime errors](#runtime-errors)). Legacy entry points `/connect/credential`
and `/connect/secret-set` still redirect here (signup org when the link has no
org context).

| Param                | Meaning                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`               | One of `credentialKinds`. Absent: the chooser starts on `secret`.                                                                                                                                                                                    |
| `kindMode`           | `hint` (default): `kind` is preselected and the kind chooser is shown. `required`: the kind is locked and no chooser is shown. Ignored without `kind`.                                                                                               |
| `name`               | Prefilled credential name.                                                                                                                                                                                                                           |
| `provider`           | Prefilled provider slug (`^[a-z0-9-]+$`).                                                                                                                                                                                                            |
| `description`        | Prefilled description.                                                                                                                                                                                                                               |
| `allowedHosts`       | Prefilled hosts, comma separated or repeated (same as `/connect/secret-set`).                                                                                                                                                                        |
| `forPackage`, `need` | The package (kody id) and need key this credential is for. After saving, the page offers the approval link that maps it as the default. (`package` is taken: `/connect/secret-set` reads it as an allowed package id.)                               |
| `loginExchange`      | For `kind=login`: the `login_exchange` JSON (`url`, `bodyFormat`, `body`, `tokenPath`, ...) the need expects. The page asks only for the login fields its `body` names (`{email}`, `{password}`, ...). Without it, the person fills in the exchange. |
| anything else        | Passed through unchanged to the reused form: `/connect/secret-set` params (`scope`, `packageId`, `expiresAt`, `allowedPackages`) or `/connect/oauth` params (`authorizeUrl`, `tokenUrl`, `scopes`, `flow`, ...).                                     |

The page saves `secret`, `url`, `login`, and `signing` in place through the
website save (`POST /account/secrets.json`, `action: "save"`), which accepts
`kind`, `hosts`, and `loginExchange` and validates them exactly as `secretSet`
does. The person types the value, so no agent ever holds it. `oauth` hands off
to `/connect/oauth` with the same query plus `org=<org>` (the OAuth redirect URI
stays org-less; `org` binds account writes to the creation org), and `mcp` to
`/@<org>/-/mcp-servers/new`.

Codecs: `buildCredentialCreateHref(input)` and
`parseCredentialCreateQuery(url)`.

## Credentials list API

```
GET /account/credentials.json?q=&kind=&scope=&packageScoped=&locked=
```

Session-authenticated (website), for the current org binding. The MCP / Open API
twin is the `credentialList` capability (`GET /v1/credentials`, with `kinds` in
place of `kind`) taking the same filters and returning the same `credentials`
array.

| Filter          | Values                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| `q`             | Case-insensitive substring of name, provider, description, or host.                   |
| `kind`          | One of `credentialKinds`; repeatable.                                                 |
| `scope`         | `org` or `personal`.                                                                  |
| `packageScoped` | `true`: only package-scoped Keys; `false`: exclude them.                              |
| `locked`        | `true`: only credentials locked to packages; or a package id: locked to that package. |

```ts
export type CredentialListItem = {
	id: string
	kind: CredentialKind
	name: string
	scope: CredentialScope
	provider: string | null
	description: string
	hosts: Array<string>
	/** Placement through a scoped client; null when the kind has none. */
	inject:
		| { kind: 'header'; name: string; format: string }
		| { kind: 'basic'; valueAs: 'username' | 'password'; other: string }
		| { kind: 'query'; param: string }
		| null
	/** Package-scoped Key: the package it belongs to. */
	packageId: string | null
	/** Non-empty when locked to these packages (allowed packages / usage mode). */
	lockedToPackageIds: Array<string>
	expiresAt: string | null
	createdAt: string
	updatedAt: string
	status: 'ok' | 'expired' | 'needs_attention' | 'disabled'
	statusMessage: string | null
	/** MCP servers only. */
	mcp: { url: string; enabled: boolean } | null
}

export type CredentialListResponse = {
	ok: true
	credentials: Array<CredentialListItem>
}
```

- MCP servers are listed with `kind: 'mcp'`, `hosts: [<server hostname>]`, and
  `mcp.url`. Their `status` comes from stored state (enabled flag, last error),
  not a live connection probe.
- Session-scoped Keys are not listed.
- `scope: 'personal'` rows are the viewer's own personal credentials granted to
  this org. Nobody else's personal credentials appear.
- Org binding works like the other org-owned account JSON: a same-origin fetch
  from an `/@slug/-/…` page binds that org, and the Secrets section gate
  applies. Without such a Referer the signup org is used.
- Org rows follow the viewer's grants: Keys need `secret:use`; OAuth and MCP
  rows need `integration:read` (org-wide or granted on that credential).
- Package code cannot call `credentialList`.

## Package credentials API

```
GET  /profiles/:username/packages/:kodyId/credentials.json
POST /profiles/:username/packages/:kodyId/credentials.json
```

Feeds the package Credentials, Default mappings, and Triggers tabs. Requires
`package:execute` on the package; anything else is a 404.

```ts
export type PackageCredentialNeedView = {
	key: string
	/** Null when the manifest omits `kind` (any fetch-capable kind). */
	kind: CredentialKind | null
	provider: string
	description: string
	multiple: boolean
	/** The dependency that declared an inherited need. */
	from?: string
	defaults: {
		org: StoredCredentialMapping | null
		mine: StoredCredentialMapping | null
	}
	/** What an interactive run by the viewer would use. */
	effective: EffectiveCredentialMapping
	/** What the viewer may pick for this need. */
	options: Array<CredentialRef>
	/** Always set: the creation link for this need. */
	createUrl: string
}

export type PackageTriggerInstanceView = {
	enablement: {
		id: string
		state: 'on' | 'paused' | 'off'
		enabledByYou: boolean
	}
	canEdit: boolean
	mappings: Array<{
		needKey: string
		override: StoredCredentialMapping | null
		effective: EffectiveCredentialMapping
	}>
}

export type PackageTriggerView = {
	trigger: CredentialTriggerRef
	/** Webhook endpoint id, job id, or package id; null for an unminted webhook. */
	instanceId: string | null
	/** The viewer's primary enablement, or the webhook's single enabler. */
	enablement: {
		id: string
		state: 'on' | 'paused' | 'off'
		enabledByYou: boolean
	} | null
	/** Only the enabler edits; true when the viewer is (or would become) it. */
	canEdit: boolean
	mappings: Array<{
		needKey: string
		override: StoredCredentialMapping | null
		effective: EffectiveCredentialMapping
	}>
	/** Every live enablement the viewer holds (or one read-only webhook entry). */
	instances: Array<PackageTriggerInstanceView>
	/**
	 * The viewer may turn on another copy with its own credential mapping
	 * (cron and non-email subscriptions). Webhooks stay one URL / one live
	 * enablement.
	 */
	canAddInstance: boolean
}

export type PackageCredentialsView = {
	ok: true
	package: { id: string; kodyId: string; canManage: boolean }
	needs: Array<PackageCredentialNeedView>
	triggers: Array<PackageTriggerView>
	/** Credentials locked to this package, plus its package-scoped Keys. */
	locked: Array<CredentialListItem>
	/** Every need, per default and per trigger, whose effective status is not `ready` or `none`. */
	incomplete: Array<{
		needKey: string
		where:
			{ type: 'default' } | { type: 'trigger'; trigger: CredentialTriggerRef }
		status: 'unbound' | 'ambiguous' | 'unusable'
	}>
}
```

`POST { changes?: Array<CredentialMappingChange>, enablements?: Array<{ trigger, state: 'on'|'off', enablementId?, createInstance? }> }`
applies edits made directly on the website (a person editing a tab) and/or turns
the viewer's enablements on or off, then returns the updated
`PackageCredentialsView`. Mapping changes use the same validator and writer as
Approve and are atomic: every change applies, or none does. `enablements` is how
the Triggers tab toggle calls `enablementEnable` / `enablementDisable` for the
signed-in person (`createInstance: true` inserts another enablement for a cron
or non-email subscription). A trigger mapping target may include `enablementId`
(edit that instance) or `createInstance: true` (map onto a new instance). This
endpoint is session-only; MCP and API tokens cannot reach it.

- `:username` is the org slug. The viewer must belong to the org (or hold a
  grant in it) and have `package:execute` on the package; otherwise `404`.
- A malformed body (missing both `changes` and `enablements`, empty arrays for
  both, or more than 64 mapping changes / 16 enablement actions, or a value of
  the wrong shape) is `400 { ok: false, error }`. At least one of `changes` or
  `enablements` must be non-empty. When both are present, mapping writes run
  first; enablement actions run only after those succeed.
- An `off` enablement action must name an `enablementId` that belongs to the
  viewer on this package and matches `trigger`. Owners cannot use this endpoint
  to disable someone else's enablement on another package.
- An `on` action with `enablementId` is idempotent only when that enablement is
  already live for the viewer on this trigger; it does not revive an `off` row.
- Changes that cannot apply are `400 PackageCredentialsWriteFailure`:
  `{ ok: false, errors: Array<{ needKey, target, code, message, createUrl? }> }`
  with the approval error codes. Nothing is written. A trigger that disappears
  between reading and writing is the same `400` (`trigger_unknown` or
  `webhook_not_minted`).
- `409 { ok: false, error }` only when a webhook was turned on by someone else
  between reading and writing.
- When one request edits the same need and target more than once, the last edit
  wins (a set then clear on a trigger that is off never turns it on).
- A webhook another person enabled shows `enablement.enabledByYou: false`,
  `canEdit: false`, and no `mappings` (its overrides are theirs).
- `incomplete` lists the default per need, plus each trigger the viewer has
  turned on (a trigger that is off never runs).
- Every written mapping (create, update, or clear), including Approve, records
  one `credential.mapping.update` org audit event. The row names the actor and
  automation credential (kind/id), and details carry package, trigger (when
  applicable), need, and old/new credential ids — never values.

Who can write:

| Target             | Allowed                                                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default` / `org`  | Package managers. Refs must be org credentials the writer can Use.                                                                                                                                                            |
| `default` / `mine` | Anyone with `package:execute`. Refs must be credentials they can Use.                                                                                                                                                         |
| `trigger`          | The enabler only. Writing a trigger mapping for a trigger the writer has not enabled turns it on for them (webhooks must be minted first, and minting alone never turns one on; a webhook another person enabled is refused). |

Validation per change: the need exists in the published closure; each ref exists
and the writer can Use it; kind matches when the need declares one (otherwise
any fetch-capable kind, the same set as ADR 0068 resolution rule 1: `secret`,
`oauth`, `login`); provider matches when both sides have one; at most one ref
unless `multiple`.

## Mapping proposals and the approval page

### Proposal URL

```
GET /@:username/:kodyId/approve-credentials?<proposal>
```

`<proposal>` is a query string an agent can build by hand:

| Param                            | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `default[<need>]`                | Org-layer default mapping for `<need>`.                                |
| `mine[<need>]`                   | The approver's own default mapping for `<need>`.                       |
| `trigger[<kind>:<name>][<need>]` | Trigger mapping for the approver's instance of a trigger.              |
| `enable=<kind>:<name>`           | Turn a trigger on for the approver with no mapping. Repeatable.        |
| `reason`                         | Optional agent note (at most 500 characters), shown as untrusted text. |

Each mapping param is repeatable, one value per credential:

- `work` (name), `org:work` or `personal:work` (scoped name), or
  `id:<credentialId>`. A name that itself starts with `org:`, `personal:`,
  `id:`, or `name:` is written `name:<name>` (`name:id:abc` is the credential
  named `id:abc`).
- A single empty value (`default[github]=`) maps the need to `[]`. An empty
  value beside other values, or a value that is not a valid pick (`org:`), is a
  proposal error, never `[]`.
- Inside the brackets, `%`, `[`, and `]` in a need key or trigger name are
  percent-encoded a second time (`%25`, `%5B`, `%5D`), so a cron job named
  `daily]backup` is `trigger[cron:daily%5Dbackup][github]` after query decoding.
  The codecs do this; hand-built links only need it for those three characters.

`enable` splits at the first colon (`enable=subscription:acme.thing:happened`)
and needs no bracket encoding. It is how a trigger with no credential needs
reaches Approve: minting a webhook URL never turns it on, and the mint returns
`enable=webhook:<name>` as its approval link. Each distinct `enable` value
counts as one param.

`sender_kind` and `sender_value` name who an inbound-email subscription runs
for. Kinds are `member`, `address`, `domain`, and `any_authenticated`. `member`
needs a person id, `address` a normalized email address, and `domain` a bare
domain. `any_authenticated` ignores `sender_value`. Approving
`enable=subscription:email.message.received` or `email.message.quarantined`
stores that sender on the new enablement. `enablementEnable` refuses those
topics and points at this page.

At most 64 mapping params (a param's repeated values count once). Param names
that decode to the same target and need (`default[github]` and
`default[git%68ub]`) are one param. Example:

```
/@acme/pr-digest/approve-credentials?default[github]=org:acme-bot&trigger[cron:daily][slack]=team-slack&reason=Daily%20digest%20posts%20to%20Slack
```

Codecs: `buildCredentialApprovalHref(input)` and
`parseCredentialApprovalQuery(url)`.

### Approval API

```
GET  /profiles/:username/packages/:kodyId/approve-credentials.json?<proposal>
POST /profiles/:username/packages/:kodyId/approve-credentials.json?<proposal>
```

```ts
export type CredentialApprovalErrorCode =
	| 'need_unknown'
	| 'trigger_unknown'
	| 'credential_not_found'
	| 'credential_ambiguous'
	| 'kind_mismatch'
	| 'provider_mismatch'
	| 'too_many'
	| 'not_allowed'
	| 'webhook_not_minted'
	| 'webhook_other_enabler'
	| 'email_approval_required'

export type CredentialApprovalChangeView = {
	target: CredentialMappingTarget
	needKey: string
	need: {
		kind: CredentialKind | null
		provider: string
		description: string
		multiple: boolean
	} | null
	/** The stored override today; null means it inherits. */
	before: Array<CredentialRef> | null
	after: Array<CredentialRef>
	/** Approving turns this trigger on for the approver. */
	willEnable: boolean
	error: {
		code: CredentialApprovalErrorCode
		message: string
		createUrl?: string
	} | null
}

/** A trigger the proposal turns on with no mapping of its own. */
export type CredentialApprovalEnableView = {
	trigger: CredentialTriggerRef
	/** False when it is already on (or paused) for the approver: a no-op. */
	willEnable: boolean
	error: { code: CredentialApprovalErrorCode; message: string } | null
}

export type CredentialApprovalView = {
	ok: true
	package: { id: string; kodyId: string }
	reason: string | null
	/** False when any change or enable has an error, or on parse errors. */
	canApprove: boolean
	/** Pins what was reviewed: changes resolved to credential ids, and enables. */
	fingerprint: string
	changes: Array<CredentialApprovalChangeView>
	enable: Array<CredentialApprovalEnableView>
	/** Sender stored on an inbound-email enablement. Null when unnamed. */
	sender: {
		kind: 'member' | 'address' | 'domain' | 'any_authenticated'
		value: string | null
	} | null
	/** Proposal-level problems (bad param names, too many params). */
	errors: Array<string>
}
```

```ts
/** Approve refused; nothing was written. `view` is resolved fresh. */
export type CredentialApprovalFailure = {
	ok: false
	error: string
	view: CredentialApprovalView
}

export type CredentialApprovalSuccess = {
	ok: true
	view: CredentialApprovalView
}
```

- `GET` resolves the proposal for the signed-in viewer and returns
  `CredentialApprovalView`. It never writes. 401 without a session; 404 when the
  org or package is not visible or the viewer lacks `package:execute`.
- `POST { action: 'approve', fingerprint }` re-resolves the same query:
  - `canApprove` is false now: `400 CredentialApprovalFailure`.
  - A different fingerprint (a credential was replaced, or a mapping changed
    since review): `409 CredentialApprovalFailure` with the fresh view. Show it
    and let the person approve again.
  - A webhook someone else enabled between review and write:
    `409 CredentialApprovalFailure`.
  - Otherwise every change, any trigger it enables, and every `enable` trigger
    not yet on are written in one batch: `200 CredentialApprovalSuccess`, whose
    view shows the new `before`.
- One Approve applies trigger mappings and default mappings together.
- A `proposal=<id>` param names the recorded agent proposal the link came from
  (see `credentialTriggerPickSet`). The page keeps it on the `.json` GET and
  POST; it is not a mapping param. Approve records the trigger picks it applied
  on that proposal only when the viewer is the person the agent acted for and
  the link still matches the recorded proposal exactly. Otherwise it records
  nothing; the mapping write still applies.

### `credentialMappingPropose` (MCP / Open API)

Input:

```ts
{
	packageId?: string
	kodyId?: string
	defaults?: Record<string, CredentialPick | Array<CredentialPick>>
	mine?: Record<string, CredentialPick | Array<CredentialPick>>
	triggers?: Array<{
		kind: CredentialTriggerKind
		name: string
		credentials: Record<string, CredentialPick | Array<CredentialPick>>
	}>
	/** Triggers to turn on with no mapping (a webhook with no needs). */
	enable?: Array<{ kind: CredentialTriggerKind; name: string }>
	/**
	 * Sender an inbound-email subscription runs for. Required when `enable`
	 * or a trigger mapping turns on `email.message.received` or
	 * `email.message.quarantined`. `any_authenticated` omits `value`.
	 */
	sender?: {
		kind: 'member' | 'address' | 'domain' | 'any_authenticated'
		value?: string | null
	}
	reason?: string
}
```

Output: `{ approvalUrl, view: CredentialApprovalView, message }`. It validates
as the caller would approve and returns the absolute approval URL to send to the
person. It never writes a mapping. `view.canApprove: false` lists what to fix
first. When an agent calls it (a signed-in person through an MCP OAuth client,
the CLI, or an API token) and the proposal can be approved, the proposal is
recorded under that agent and `approvalUrl` carries its `proposal` param.

Open API: `POST /v1/credential-proposals`. Package code cannot call it, and a
package the caller cannot run is a caller error ("Package not found").

### `credentialTriggerPickSet` (MCP / Open API)

The one way an agent writes a pick (ADR 0068 amendment 2026-10-13, "How picks
change"): it sets one need on the caller's own instance of one trigger, only to
a value that same agent proposed and the person approved from its link. Use it
to switch a trigger back to an approved pick after it changed.

Input:

```ts
{
	packageId?: string
	kodyId?: string
	trigger: { kind: CredentialTriggerKind; name: string }
	needKey: string
	credentials: CredentialPick | Array<CredentialPick> // [] is none on purpose
}
```

Output: `{ trigger, needKey, credentials: Array<CredentialRef>, message }`.

- **Agent.** The person (`actor`) plus the request credential: kind `mcp-oauth`,
  `cli`, or `api-token`, and its id (the OAuth client or token). A browser
  session, a triggered run, package code, or a client with no id is refused.
  Another client or token of the same person is another agent.
- **Guard.** The picks resolve to credential ids exactly as Approve resolves
  them. The call is refused unless one of this agent's approved proposals for
  this package holds the same trigger (and webhook endpoint), need, and ids in
  the same order. A value the agent proposed but nobody approved, a value the
  person approved on an edited link, and a value another agent proposed are all
  refused.
- **Same path.** The write runs through `approveCredentialProposal`: the same
  validation (kind, provider, Use, webhook enabler), the same one-batch write,
  and the same audit as Approve.
- **Never turns a trigger on.** A trigger that is off for the caller is refused;
  turning it on needs approval.
- Open API: `PUT /v1/credential-trigger-picks`. There is still no
  `enablementUpdate` or `enablementEnable { credentials }` that writes arbitrary
  picks.

### Webhook mint and delivery

Minting a webhook URL never turns it on. `webhookUrlMint` / `webhookUrlRotate`
return `approval_url` (the website mint and rotate responses: `approvalUrl`)
while the endpoint has no enablement that is on or paused; it is null once one
exists. An existing enablement is left alone.

A delivery that runs nothing answers 409:

```ts
{
	ok: false
	error: {
		code: 'enablement_not_on'
		/** Says "not approved" or "paused", and includes the link. */
		message: string
		details?: { approvalUrl: string }
	}
}
```

### Paused on a trigger mapping

Before each run, the run gate checks the credentials the instance's trigger
mapping names for needs the package declares (not the defaults, and not `[]`).
If a named credential is deleted, the enabler lacks Use on it, or it does not
fit its need's current kind or provider, the enablement pauses instead of
running:

```ts
pause: {
	reason: 'credential_access'
	permission: null
	resourceType: 'credential-mapping' // enablementMappingPauseResourceType
	resourceId: string // the need key
	credentialId: string // the missing credential
}
```

The next event checks the mapping again and resumes the enablement once every
named credential is usable, including after the enabler remaps the need. The
Waiting list says which need to remap. A publish that adds needs while the
package has live enablements gets a check note saying how those runs resolve
them.

## Runtime errors

`CredentialClientError` bodies (`credential()` in package and ad hoc code, CLI
local, CapabilityProxy) gain:

```ts
export type CredentialClientErrorBody = {
	code: CredentialClientErrorCode
	message: string
	retryWith: Array<CredentialClientRetry>
	options?: Array<CredentialClientOption>
	possibleMatches?: Array<CredentialClientOption>
	/** Absolute creation link. Always set for credential_unbound, credential_ambiguous, and credential_not_found. */
	createUrl?: string
}
```

- The message ends with `Create one at <createUrl>` so agents that only read the
  message still get the link.
- `credential_unbound` for a need that declares `kind` links with
  `kindMode=required`; for a need without `kind` it links with `kindMode=hint`
  (`oauth` when a platform OAuth app exists for the provider, plus
  `platform=<slug>`; else `secret`). `provider`, `name` (the need key),
  `description`, `forPackage`, and `need` are prefilled. When the run's org is
  known, the link opens that org's page (`/@<org>/-/credentials/new`).
- `credential_ambiguous` carries the same link beside `options` and `retryWith`,
  so the person can create a dedicated credential instead of picking one.
- A failure fails only that `credential()` call. In a trigger run, a need a
  republish added that has no single matching credential (unbound or ambiguous)
  never pauses the trigger: the call fails with the error and its link, and the
  trigger's other calls and later runs continue, as for any other runtime
  credential error. Only a credential the trigger mapping names pauses it (see
  "Paused on a trigger mapping").
- `credential_not_found` for `credential.named(name)` links with `name`
  prefilled and no kind.
- A missing `{{secret:NAME}}` placeholder in a run keeps its `secret_required`
  details; its `nextStep` points at the creation link
  (`/@<org>/-/credentials/new?kind=secret&kindMode=required&name=NAME` when the
  run org is known; otherwise the legacy `/connect/credential?...` redirect).

## Redirects

These URLs redirect (302, query preserved) to the Credentials UI:

| From                    | To                                    |
| ----------------------- | ------------------------------------- |
| `/@:org/-/secrets`      | `/@:org/-/credentials?kind=secret`    |
| `/@:org/-/integrations` | `/@:org/-/credentials?kind=oauth`     |
| `/@:org/-/mcp-servers`  | `/@:org/-/credentials?kind=mcp`       |
| `/connect/secret-set`   | `/connect/credential?kind=secret&...` |

Only index pages redirect. Deeper paths that are approval or OAuth flows
(`/@:org/-/secrets/approve`, `/@:org/-/mcp-servers/:serverId/authorize`,
`/account/mcp-servers/oauth/callback`) keep serving. `/connect/oauth` never
redirects: it is the registered OAuth redirect URI for bring-your-own apps.
`credentialRedirectFor(url)` (`universal/credential-redirects.ts`) returns the
new path and query or null so the router and tests share one table. Legacy
`/connect/secret-set` links read `package` as an allowed package id, so the
redirect renames it to `allowedPackages` (the creation link uses `forPackage`
for the package a need belongs to).

`/@:org/-/secret-providers` stays its own page and never redirects: granting a
vault provider access is a different trust decision from using a credential,
with its own audit trail.

Where they are wired:

- Org index routes (`/@:org/-/secrets`, `/@:org/-/integrations`,
  `/@:org/-/mcp-servers`) and `/connect/secret-set` call `credentialRedirectFor`
  in `beforeLoad` and throw a 302 when the table matches.
- `/connect/credential` redirects to the creation one-pager at
  `/@:org/-/credentials/new` in the signed-in user's signup org, with the query
  preserved. A legacy `/connect/secret-set` link therefore lands on the
  one-pager in two hops.
- `/account/credentials` redirects to the signup org's Credentials list, query
  preserved. `SiteLink` uses `linkNavigation`, which treats exact native routes
  that have `beforeLoad` and no component or loader as document navigations, so
  in-app clicks follow the server 302 instead of handling the path as an SPA
  page. `/account/credits` uses the same redirect-only shape.
- URLs the table returns null for stay on the dedicated page: approval links
  (`names`, `hosts`, `package_id`, `capability`) and `package=` filters on the
  index pages. `/connect/secret-set` remains the Key intake.
