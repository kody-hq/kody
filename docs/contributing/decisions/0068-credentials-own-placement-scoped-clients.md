# 0068: Credentials own placement; scoped clients replace slots and assignments

- **Status:** accepted
- **Date:** 2026-10-11
- **Amended:** 2026-10-12 (Kent: today's secrets are the Key credential type and
  keep working permanently; the other types are opt-in; by-name grants stay; no
  old-lane removal; integration-token placeholders are permanent; the webhook
  no-actor exception stays unless a proven replacement breaks nothing);
  2026-10-12 (Kent: manifest credential need `kind` is optional — see
  [Amendment 2026-10-12](#amendment-2026-10-12)); 2026-10-12 (Kent: unbound
  errors carry a creation-page link; Approve bundles trigger and ad hoc default
  mappings; creation-link kind hint/required; MCP servers are credentials in the
  Credentials list — see [Amendment 2026-10-12](#amendment-2026-10-12));
  2026-10-12 / 2026-10-13 (Kent: minting a webhook URL no longer turns it on;
  webhook URLs are identities and the declared name is display metadata only —
  see [Amendment 2026-10-12](#amendment-2026-10-12)); 2026-10-13 (Kent: stored
  default and trigger credential mappings; agents may set a trigger pick only to
  a value they already proposed, still through approval — see
  [Amendment 2026-10-13](#amendment-2026-10-13-credential-mappings)); 2026-10-13
  (Kent: creation pages carry org as a URL segment with no org picker; Secret
  providers stay separate from the Credentials list — see
  [Amendment 2026-10-12](#amendment-2026-10-12)); 2026-10-15 (Kent, approved
  2026-10-14: a package run by anyone but its author uses only declared
  credentials, behind a flag — see
  [Amendment 2026-10-15](#amendment-2026-10-15-credential-need-enforcement));
  2026-10-16 (Kent: multiple minted URLs per declared webhook name with instance
  labels and separate Approve each — see
  [Amendment 2026-10-16](#amendment-2026-10-16-webhook-multi-instance));
  2026-10-16 (Kent: packages that stored a credential stamp may use only
  declared slots; unstamped packages keep the legacy path — see
  [Amendment 2026-10-16](#amendment-2026-10-16-stamped-packages-fail-closed));
  2026-10-17 (Kent: each credential owns an allowed fill-placement for
  placeholders; null means anywhere until migration and enforcement — see
  [Amendment 2026-10-17](#amendment-2026-10-17-per-credential-fill-placement));
  2026-10-20 (Cole: package needs may declare fill placement applied on
  package-scope insert; runtimes still cannot widen placement — see
  [Amendment 2026-10-20](#amendment-2026-10-20-package-manifest-fill-placement));
  2026-10-24 (Kent: package apps run as their publisher; visitors bring only
  identity; see
  [Amendment 2026-10-24](#amendment-2026-10-24-package-apps-run-as-their-publisher));
  2026-10-27 (Kent: saved packages declare the secret provider package they use
  with a `kind: "secret-provider"` slot; see
  [Amendment 2026-10-27](#amendment-2026-10-27-secret-provider-slots));
  2026-10-29 (Kent: placeholders and `createAuthenticatedFetch` resolve the
  actor's own granted personal credentials, the set scoped clients resolve; see
  [Amendment 2026-10-29](#amendment-2026-10-29-placeholders-and-createauthenticatedfetch-resolve-granted-personal-credentials))
- **Supersedes in part:** [0021](./0021-publish-gated-package-composition.md)
  (credential authority for the opt-in types used through scoped clients), and
  credentials plan v4 section 3.3 (assignments) and section 3.4 (placeholder
  grammar). The v4 plan lives outside this repo.

This record is the source of truth for the credentials model. Credentials plan
v4 still holds for personal credentials (3.2), enablements, the one
`resolveCredential` door, audit, and leak tests, except where this record
changes them. The rule is: do not break people while improving things for the
future. Key credentials (today's secrets and their placeholders) keep working
exactly as they do, with the authority rules of the records this one supersedes
in part.

## Context

Package code reaches credentials through `{{secret:NAME}}` and
`{{integration-token:NAME}}` placeholders. The fetch gateway fills them anywhere
in an HTTPS request to an allowed host: headers, the URL path and query, and
text bodies. Code therefore decides where a value goes. Echo redaction is
exact-match and covers only the response to the same fetch, so it cannot close
that class on its own.

Plan v4 answered with manifest slots (`kody.credentials`), org assignments of a
credential to each slot (3.3), and a placeholder grammar keyed by slot (3.4).
Assignments add a mapping table, saved bindings, and a package-level grant that
stands in for the actor's Use. This record replaces that with credentials that
own their hosts and placement, and a scoped client as the surface for the new
credential types.

The first version of this record also retired placeholders at a cutover. Kent
amended it on 2026-10-12: placeholders are the Key type and stay, and the new
types are more secure options that owners opt into.

Baseline: [#3210](https://github.com/kentcdodds/kody/pull/3210) (`77a82ed3`)
requires the actor's Use on CLI local execute even when a package id is stamped,
and [#3169](https://github.com/kentcdodds/kody/pull/3169) (`0d140d22`) enforces
per-resource Use when resolving org credentials. This record builds on both.

## Decision

In short:

- **Key** is today's secret, and it keeps working permanently: placeholders fill
  anywhere in an HTTPS request to one of its allowed hosts. There is no cutover
  that removes it.
- The other types (`header` / `basic` / `query` inject through a scoped
  `credential(key)` client, OAuth through a client, `url`, `login`, and
  `signing`) are more secure options, not a forced migration. With them a
  credential owns its hosts and placement (never the body) and code never
  decides where a value goes.
- Through a scoped client, the actor's Use plus `package:execute` is the only
  authority and package stamps grant nothing.
- Callers pick among candidates with a call map; triggers store the pick in an
  enablement. Zero or several candidates is a structured error, never a default.
- Slots as grants, assignments, and saved bindings are not built. By-name grants
  stay. Nothing is scheduled for removal.

The sections below are the full specification.

### Primitives

There are four:

1. **Credential.** An org-owned or user-owned secret, OAuth connection, or MCP
   server. It owns its hosts and how its value is placed in a request.
2. **Resolver.** One per credential kind, all behind the one `resolveCredential`
   door.
3. **Scoped client.** The credential surface for the opt-in types. Key
   placeholders stay beside it.
4. **Enablement.** The only persisted credential choice, used for triggers
   (cron, subscription, webhook) that have no live caller.

There are no mapping or assignment tables and no saved bindings. The
[credential mappings amendment](#amendment-2026-10-13-credential-mappings)
replaces this rule and item 4: package default mappings and per-trigger mappings
are stored. Key placeholders, package allowlists, and usage modes stay (see
[Key credentials](#key-credentials)).

### Key credentials

Key is the credential type for today's secrets, and it keeps working exactly as
it does, permanently:

- `{{secret:NAME}}` placeholders fill anywhere in a request (a header, the URL
  path or query, or a text body) when the request is HTTPS and its host is one
  the secret allows.
- `{{integration-token:NAME}}` placeholders are permanent too, and fill the same
  way on the integration's allowed hosts. OAuth through a scoped client is an
  opt-in option beside them, not a replacement.
- `kody.secretMounts`, `packageSecrets`, `|scope=`, webhook `secretName`,
  `x-kody-secret-resolution`, package allowlists, usage modes, provider grants,
  and today's package authority rules
  ([0021](./0021-publish-gated-package-composition.md)) keep working.
- Body, other, and computed placements are fine. Publish, `packageGet`, and
  `repoRunChecks` never warn in a way that implies breakage. Where a more secure
  type fits a placement, they may gently suggest it (see
  [Which more secure type fits](#which-more-secure-type-fits)).
- A Key can also be used through `credential(key)`, which places it by its
  `inject` rule. The same Key keeps filling placeholders.

### Resolver interface

- `resolve(need, pick, actor)` returns
  `handle | unbound | ambiguous | not_found`. The handle holds metadata only,
  never a value.
- `authorize(handle, request)` returns
  `ok | host_not_allowed | insecure_transport | denied`. It checks the actor's
  org access (cached for about 60 seconds, then checked again), the actor's Use
  on the credential, a live org grant for a personal credential, that the host
  is in the credential's `hosts`, and that the request is HTTPS.
- `apply(handle, request)` injects the credential. It runs only in the gateway
  and only after `authorize` returns `ok`. It is the only step that reads a
  value, so a refused host never triggers a token refresh. For `signing`, it
  produces a signature.
- `audit(outcome)` writes one row per resolution, including denials: person,
  oauthClientId, package, need key, credential id, and outcome. Never a value.

Kinds: `secret` (Key), `oauth`, and `mcp` (the `mcp` client exposes `callTool`,
not `fetch`). Later kinds are new resolvers in the same door, not new lanes, and
owners opt into them:

- `login`: the gateway runs the login exchange and injects only the session
  token; the login response never reaches code.
- `url`: a whole-URL secret pinned to its own host, over HTTPS.
- `signing`: signs requests (a JWT or an HMAC) for one of its hosts; code gets
  the signature, never the key. Today's webhook verification keeps working with
  Keys; a `verify` operation can be added if an owner wants a signing-type
  webhook secret.

### Credential fields

```
{ id, ownerKind: 'org'|'user', kind, provider: slug|null, name, hosts[], inject, source: 'stored'|{ vault, ref } }
```

`inject` decides placement when a credential is used through a scoped client
(Key placeholders keep their own placement). It never places a value in the
body. It is one of:

- `header{ name, format }`. The default is `Authorization: Bearer {value}`.
  OAuth credentials always use Bearer.
- `basic{ valueAs: 'username'|'password', other?: string }`. `other` is a
  non-secret literal and defaults to `''`. When both parts are secret, use the
  `login` kind.
- `query{ param }`.

There is no `pathPrefix`; `/bot<token>/` style URLs use the `url` kind.

The creator sets `hosts` and `inject` (usually an agent through `secretSet` or
the connect page). Only the credential's manager edits them (the owner, for a
personal credential), and every edit is audited. Nothing in a manifest hints at
or pre-fills them.

Hosts: no hosts denies every request; entries are exact hosts or a wildcard at
most one level deep (`*.example.com`); HTTPS only; redirects are followed
manually and authorized again on every hop. A `url` credential owns its whole
URL, so its client returns redirects unfollowed.

Personal credentials follow plan v4 3.2: user-owned, granted to orgs one org at
a time, never usable by Owners or Automation on someone else's behalf. A
personal OAuth credential minted through an org's OAuth app is pinned to that
org. The owner manages grants with `credentialOrgGrant`, `credentialOrgRevoke`,
and `credentialOrgGrantList` (live person and Write on the credential to change
one; audited in the owner's personal org).

### Use grants (`accessGrant` / `accessRevoke`)

`accessGrant` and `accessRevoke` keep accepting secret and integration names and
resolve each name to a credential id at grant time. Granting and revoking by
credential id is added alongside. By-name grants (including grant invites and
`accessList` filters) stay permanently; they are not slated for removal.

Use on a vault's door-key secret does not cover the vault, which is its own
credential. Nothing is left to remove there.

### Manifest (`kody.credentials`)

The keyed map stays. `provider` is optional and defaults to the key.
`description` is required. `kind` is optional (see
[Amendment 2026-10-12](#amendment-2026-10-12)).

```json
"credentials": {
  "github":     { "description": "Read PRs to summarize them" },
  "github_bot": { "kind": "oauth", "provider": "github", "description": "Bot account" },
  "google":     { "kind": "oauth", "multiple": true, "description": "Calendars" }
}
```

- Publish warns (does not fail) when a key is not a provider slug
  (`^[a-z0-9-]+$`).
- A second account from the same provider gets its own key with an explicit
  `provider`. There is no `as` field.
- Omitting `kind` means any fetch-capable credential for that provider (Key /
  secret such as a PAT, oauth, or login). The `credential()` client picks the
  code path (inject header, OAuth refresh on 401, login exchange). Package code
  is identical for PAT vs OAuth. Declare `kind` only when a specific shape is
  needed (`signing` for `sign()`, `mcp` for `callTool()`, `url`, or a
  provider/feature that truly requires one kind, such as oauth for Google user
  data). A declared `kind` keeps today's narrowing, so published manifests stay
  valid.
- There is no hosts or inject field. Optional `placement` on a need is the
  reviewable default for package-scope secret inserts of that name (see
  [Amendment 2026-10-20](#amendment-2026-10-20-package-manifest-fill-placement)).
- **Needs closure:** the package's needs plus those of its snapshotted
  dependencies (pinned at the dependent's publish, per
  [0001](./0001-no-package-versioning.md)), computed at publish and stored with
  the bundle. A key that conflicts on kind or provider is a publish error.
- `packageGet` tags needs inherited from a dependency with `from`.

### Code API (`kody:runtime`)

- `credential(key)` returns `{ name, scope, kind, hosts }` plus `fetch` (secret,
  oauth, url, login), `callTool` (mcp), or `sign` (signing). A relative URL
  resolves against the credential's first host; an absolute URL must be in
  `hosts`. If code sets the header the credential injects, the gateway
  overwrites it.
- `credentials(key)` returns an array, for `multiple: true` needs.
- An undeclared key (ad hoc execute or author-only code) is treated as the
  provider.
- `credential.named(name)` picks by exact name. It works only in ad hoc execute
  and in unshared packages in a personal org. Sharing (Community listing,
  granting Use, moving into a team org) is refused while `named` remains, and
  `repoRunChecks` lists the call sites. Runtime checks it again.
- Client handles are opaque and scoped to one run. Passing a client to a
  function in an imported package is explicit capability passing.
- SDKs that accept a custom fetch take `fetch: gh.fetch`.

### Call shapes

`packageInvoke` and ad hoc `execute` take a map:

```
credentials: { github: 'work', google: ['work','personal'], x: { name: 'work', scope: 'org' } }
```

The CLI takes `--credential github=work` and `--credential x=org:work`. Triggers
do not take a map at enable time; their picks are stored trigger mappings,
resolved on each run (see the
[credential mappings amendment](#amendment-2026-10-13-credential-mappings)). An
admin can disable someone else's enablement but cannot point it at different
credentials.

### Resolution rules

1. **Candidates:** credentials with the need's provider that the actor can Use
   in the run org (org credentials with Use, plus the actor's own personal
   credentials granted to that org). When the need declares `kind`, candidates
   must also match that kind; when `kind` is omitted, any fetch-capable
   credential for the provider qualifies (Key/secret, oauth, login). A null
   provider never auto-resolves.
2. **Map entry:** an exact pick. Kind must match when the need declares one;
   provider must match when both sides have one.
3. **No map entry:** exactly one candidate is used (`[it]` for `multiple`); zero
   is `credential_unbound`; two or more is `credential_ambiguous`. A `multiple`
   need never gets "all of them". An explicit `[]` means none on purpose.
4. **Timing:** map values are validated before code runs. An unknown map key is
   an error in `packageInvoke` and a warning in ad hoc execute or with a dynamic
   `import()`. Needs without a map entry resolve lazily on first use.
5. **Pinning:** the pick is pinned for the run; `authorize` still runs on every
   request.
6. **Authority:** the actor's Use plus `package:execute`, nothing else. Package
   stamps (attested or claimed) never grant anything; they only select which
   needs and storage apply. CLI `--local` stays closed by construction and
   values never reach the local machine.
7. **Name collisions:** an org and a personal credential with the same name
   return `credential_ambiguous` listing both; the caller retries with
   `{ name, scope }`.
8. **Drift:** a need that auto-resolved becomes ambiguous when a second match is
   added, and the error carries a ready-to-retry call. Pinned trigger mappings
   store ids and do not drift; a trigger need without an override follows the
   current defaults on each run. There is no global default credential
   (per-person and org default mappings are the only defaults).

### Errors

Every error is structured and includes `retryWith`.

| Error                                   | Meaning                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `credential_unbound{ possibleMatches }` | No candidate. Lists matching-kind credentials with a null provider (fetch-capable when `kind` is omitted), filtered by Use. |
| `credential_ambiguous{ options }`       | More than one candidate.                                                                                                    |
| `credential_not_found`                  | Missing or not usable by the actor; one error for both so it reveals neither.                                               |
| `credential_need_unknown`               | The map names a key the package does not declare.                                                                           |
| `credential_need_undeclared`            | A package run by anyone but its author uses a credential it does not declare (see the 2026-10-15 amendment).                |
| `credential_denied`                     | Authorization failed.                                                                                                       |
| `credential_rate_limited`               | Visitors of an app used an owner's credential too often (see the 2026-10-16 owner credentials amendment).                   |
| `host_not_allowed`                      | The host is not in the credential's `hosts`.                                                                                |
| `insecure_transport`                    | The request is not HTTPS.                                                                                                   |

A 401 or 403 from a client fetch adds a hint naming only the inject shape (for
example `header Authorization Bearer`), never a value, the hosts, or other
credentials. An explicit pick of a null-provider credential hints "set provider
to X to auto-resolve"; Kody never writes the provider itself.

### Agent read (`packageGet`)

```
credentials.needs[]: {
  key, kind, provider, description, multiple, from?,
  status: 'ready'|'ambiguous'|'unbound',
  autoPick: name|null,
  yourOptions[]: { name, scope: 'org'|'personal', org?, hosts[] }
}
```

Every option and match is filtered by the actor's Use. From T, `packageGet` may
gently suggest a more secure type where one fits a Key placeholder. It never
warns as if the placeholder will break.

### Surfaces

- **Interactive** (MCP, CLI, Open API): the caller supplies the map.
- **Package app:** the signed-in visitor is the actor, with auto-resolve only. A
  platform-rendered picker held in the visitor's browser session, and
  app-service credentials (a later enablement kind with an explicit enabler),
  are deferred until there is demand. Until then, grant Use to the role.
- **Enablements:** each stores credential ids; its runs act as the enabler, who
  is billed and audited. It pauses when the enabler loses Use, a credential is
  deleted, or a republish adds an ambiguous or unbound need, and resumes on its
  own once the cause clears, notifying the enabler. A need added by a republish
  auto-resolves on each run without storing anything, and the publish response
  warns when the package has live enablements. Webhook verification may also go
  through the door with the enablement as the actor. The no-actor exception for
  webhook verification stays unless a proven replacement exists and nothing that
  works today breaks. The webhook URL secret (`url-secret`) is already a
  permanent, explicit verification type.
- **Inbound email:** a member sender is the actor. Mail from a non-member runs
  the inbox owner's enablements.

### Identity and MCP tokens

- Nothing resolves without a `PersonId` actor with a live org binding, except
  the webhook verification no-actor exception, which stays (see Surfaces).
- New OAuth grants require `personId`, stamped at consent the same way
  [0064](./0064-oauth-org-binding.md) stamps `orgId`.
- Legacy grants in a personal org derive the person after a database check (the
  org is personal and that person is its only member). In a team org, a grant
  with no person must re-consent and fails closed until then.
- At P9 the props fallbacks (`orgId ?? userId` and the person fallback) are
  dropped.

### Security properties

- No credential value enters package or user code, logs, errors, or tool output.
- With the opt-in types, code never decides where a value goes. Placement
  belongs to the credential and is never the body. A Key placeholder goes where
  code puts it, on the Key's allowed hosts over HTTPS.
- Publishing, republishing, or forking cannot widen a credential's hosts or
  placement.
- Through a scoped client, the actor's Use is the only grant; CLI `--local`
  stays closed.
- Personal credentials work only in their owner's runs, in orgs the owner
  granted them to.
- Option lists never reveal credentials the actor cannot use.
- Echo redaction stays as defense in depth.
- Remaining risk: a token can do whatever it allows on its allowed hosts. Keep
  hosts narrow and OAuth scopes minimal and visible, and prefer a more secure
  type where one fits.

### Lifecycle

- **Org access ends:** that org's personal grant row is hard-deleted and
  affected enablements pause. OAuth credentials pinned to that org are wiped and
  revoked upstream.
- **Owner deletes a credential:** the value is tombstoned immediately, with no
  restore. Grants and pending grant invites on its id and its personal org
  grants are removed in the same batch.
- **Account deleted:** every value is tombstoned at soft delete and never
  restored; rows are purged per [0066](./0066-soft-delete-and-purge.md).
- **Account suspended:** resolution is denied and nothing is wiped.

### Rollout

T is the date the new credential types are available, opt-in: the client API,
call maps (invoke, execute, CLI, enable), `packageGet` needs, the stored needs
closure, and stored credential mappings. Nothing existing changes at T.

**Key behavior (Kent, 2026-10-11, made permanent 2026-10-12):** production keeps
filling placeholders anywhere on allowed hosts over HTTPS. There is no switch to
header-only, before or after T.

**P1 (before T, no visible change):** add `provider`, `inject`, and `source`
columns. Backfill `provider` from OAuth apps and from the slots that reference
each secret. Backfill `inject` from consistent usage in stored package source,
defaulting to Bearer when usage is inconsistent or absent. Ship personal
credentials and org grants (v4 3.2) as backend only: schema, service, and
resolver candidates, with no public capability or UI until T. Stamp `personId`
on new OAuth grants.

**T:** ship the opt-in types above. The `login`, `url`, and `signing` kinds ship
as they are ready; none of them is a prerequisite for anything existing to keep
working.

**Suggested rewrites (optional, owner-approved):** the fleet codemod proposes a
rewrite only when the result behaves identically, as a proposal in the owner's
waiting-for-me list. Nothing is rewritten or republished without the owner's
approval, and declining changes nothing.

- It can propose: a placeholder in a literal header in the `init` object that
  matches the credential's backfilled `inject`, where the credential's hosts
  cover the URL (URLs stay absolute); integration-token placeholders only when
  the header is exactly `Authorization: Bearer`; query placeholders only when
  the backfill found one consistent param; secret basic auth with a literal
  username and a secret password, to `basic{ valueAs: 'password', other }`.
- It proposes nothing for dynamically built headers, a credential used with two
  header shapes, placeholders in the body or path, basic auth where both parts
  are secret, calls that set `x-kody-secret-resolution`, or vault placeholders.
  Those stay as they are, with at most a gentle suggestion of a more secure type
  where one fits.
- An accepted proposal is one revertable commit, republished only when the
  package is clean, has no drift, and passes its checks.
- A proposal may rename a declared key named after a secret (for example
  `RESEND_API_KEY`) to its provider when that provider is unique in the package.
- A proposal may convert a package-scoped value into an org credential named
  `<package-leaf>-<name>` (suffixed if taken), add the matching manifest need,
  and set the credential's provider so it auto-resolves, with `hosts` and
  `inject` from the backfill. The proposal lists the Use grants it would add:
  whoever wrote the value, and in team orgs members who ran the package in the
  last 90 days. Package-scoped values the owner does not convert keep working.

**No old-lane removal (Kent, 2026-10-12):** there is no removal date, rescan
gate, publish refusal of placeholders, window, or owner email. The gateway keeps
parsing placeholders, and by-name grants stay.

**P9:** drop the grant-props fallbacks.

### Which more secure type fits

A guide for suggestions, not a requirement: every placement below keeps working
as a Key. Publish, `packageGet`, and suggested rewrites use it to point an owner
at a more secure type when one fits; where none fits, they say nothing.

From the production credential inventory scan of 2026-10-12 (1034 packages). The
rows count placeholder references; with the 213 variable definitions the scan
also records (not placements), they add up to its 881 references.

| Placement (references)                                                                | More secure type that fits                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Header (355)                                                                          | Key with a `header` inject, through a scoped client   |
| Query parameter (1)                                                                   | Key with a `query` inject                             |
| Basic auth with a literal username and a secret password (0)                          | Key with a `basic` inject                             |
| URL path, such as `/bot<token>/` (20)                                                 | `url`                                                 |
| A password or refresh token posted to get a session (13)                              | `login`, or OAuth when the provider is an integration |
| Signing key (2)                                                                       | `signing`                                             |
| Webhook verification secret (4)                                                       | None needed; Keys verify webhooks                     |
| Other body fields, mostly identifiers such as a chat id (19)                          | None needed                                           |
| Values the scan cannot follow to a request: objects, returns, arguments, arrays (254) | None needed                                           |

Counted separately: 17 `secretJwtSign` calls (`signing` fits them too), and 256
computed and 10 vault placeholders, whose name or placement is known only at run
time (none needed). When a new placement shows up that no type fits, it stays a
Key, and the revisit-if below applies only if someone wants it covered.

## Consequences

- One door, four primitives, no mapping tables. Owners who opt into the new
  types get placement owned by the credential, which keeps values out of request
  bodies and paths for those credentials.
- Nobody is broken: Key placeholders, by-name grants, and today's package
  authority keep working, and suggestions are optional.
- Through a scoped client, authority is uniform: the actor's Use plus
  `package:execute`. Key placeholders keep the package authority that
  [0021](./0021-publish-gated-package-composition.md) records.
- Interactive calls through a client can hit `credential_ambiguous` after a
  second matching credential is added; the error carries a ready-to-retry call.
  Enablements do not drift.
- Two lanes stay side by side on purpose: Key placeholders and scoped clients.
- Kent decides each user-visible change before it ships.

**Revisit-if** a placement appears that no resolver kind can express without
returning a value to code.

## Amendment 2026-10-12

Kent: manifest credential need `kind` becomes **optional**.

- **Omitted `kind`:** any fetch-capable credential for that provider qualifies
  (Key/secret such as a PAT, oauth, login). The `credential()` client picks the
  code path (inject header, OAuth refresh on 401, login exchange). Package code
  is identical for PAT vs OAuth.
- **Declare `kind` only when a specific shape is needed:** `signing` (`sign()`),
  `mcp` (`callTool()`), `url`, or a provider/feature that truly requires one
  kind (for example oauth for Google user data). A declared `kind` keeps today's
  narrowing, so published manifests keep working (non-breaking).
- **`provider`** still defaults to the key (unchanged). **`description`** stays
  required; it never affects matching. It explains to the user or agent why the
  package wants access when mapping or when a need is ambiguous or unbound.
- **Typical need:** `"github": { "description": "Read PRs to summarize them" }`.
- **Missing scopes** surface at call time via 401/403 `x-kody-credential-hint`.
  Declaring scopes is possible future work.
- **Naming direction:** `credentials` is the umbrella term everywhere (secrets
  and integrations are credential subtypes). MCP servers are credentials too and
  appear in the Credentials list with other usable credentials. That does not
  fold Secret providers into that list; vault access stays on its own page (see
  below).
- **Unbound / missing at runtime:** when a run hits a missing or unbound
  credential, the agent always surfaces a link to the credential creation page,
  never a bare error. `credential_unbound` and `credential_not_found` errors
  carry that link.
- **Credential approval page:** one Approve action bundles trigger mappings and
  ad hoc default mappings together.
- **Creation-link design:** agents provide a link like the existing
  secret-intake (`/connect/secret-set`) and `/connect/oauth` flows. A query
  param for `kind` can be a **hint** (default kind, chooser shown) or
  **required** (kind locked, no chooser UI). The one-pager reuses the existing
  secret-intake or OAuth components, chosen by kind.
- **Creation page has no org picker (Kent, 2026-10-13 ~9:10 AM MT):** each MCP
  connection and the CLI are attached to a specific organization. Creation pages
  and agent-generated creation links carry that org as a URL segment, so the
  page does not offer an org picker.
- **Secret providers stay separate (Kent, 2026-10-13 ~9:10 AM MT):** the Secret
  providers page stays separate from the Credentials list, because vault access
  is a different trust decision with its own audit trail.
- **Webhooks go through Approve, not mint (Kent, 2026-10-12 ~10:50 PM MT and
  2026-10-13 ~9:07 AM MT):** minting a webhook URL no longer turns the webhook
  on for the minter. New webhooks need a separate Approve step on the same
  approval page as other triggers, with one Approve that also maps credentials
  for that instance. Kent accepts the extra approval as the long-term design,
  not an interim step. The mint returns the approval link while nobody has
  approved it, and a delivery to a webhook that is not on fails with a clear
  error that includes the link. Existing enablements, including migrated ones
  and any an earlier mint created, stay untouched; remint and rotate never
  change them. **Webhook URLs are identities;** the declared webhook name is
  display metadata only. (Amended 2026-10-16: several URLs may share one name —
  see [Amendment 2026-10-16](#amendment-2026-10-16-webhook-multi-instance).)

## Amendment 2026-10-16: webhook multi-instance per declared name

Kent decided (2026-10-16): webhooks support multiple instances under the same
declared webhook name.

- Each additional instance **mints its own new URL** under that name.
- A short **user-set instance label** tells URLs apart in Settings and Triggers.
- Each new URL needs its **own separate Approve** after minting (same Approve
  path as a first mint; enablement still binds to the endpoint id).
- Existing webhooks and their URLs stay untouched; the migration is **additive
  only** (relax the unique `(user, package, name)` index so several endpoints
  may share a name; do not delete rows).
- The **URL (endpoint id) is the identity**; the declared name remains display
  metadata. Raw URLs and IDs stay behind the Details disclosure.

## Amendment 2026-10-13: call maps and pinned needs

Kent decided four call-map questions (#3599).

1. **Strict invoke.** In an invoked run, a call-map key that no package in the
   run declares fails the run before it starts (`credential_need_unknown`). A
   dependency imported by a computed specifier, whose needs cannot be known up
   front, is refused in strict mode. Ad hoc `execute` code only warns.
2. **Pinned needs.** A published app runs against the credential needs
   snapshotted at its publish (its needs closure), so a dependency cannot
   quietly gain credentials. Only a change to credential needs, transitive
   included, pauses a publish for approval; other changes publish freely. A
   dependency change never rebuilds or republishes a public app on its own.
3. **Where the map goes.** The `credentials` map is accepted on MCP `execute`
   (for `code`; the `invoke` field is gone per
   [0085](./0085-execute-takes-code-only.md)) and on the CapabilityProxy (CLI
   `--credential`). It is not accepted on the package-callable `execute`
   capability: package code would pick credentials by name there, which would
   bypass `credential.named`'s sharing rules.
4. **Several picks for one `credential(key)`.** It is an error whose message
   lists every option by name and scope, with matching `options` and
   `retryWith`, so an agent can pick one or show them to the user. The same
   holds for `credential_ambiguous`.

## Amendment 2026-10-13: credential mappings

Kent (voice, 2026-10-12, and 2026-10-13 ~9:07 AM MT): packages get explicit,
human-approved credential mappings. This changes "no mapping tables" and "there
is never a default credential" in the sections above, and nothing else. These
are the long-term design, not an interim step.

- **Default mappings:** a package may store an ad hoc default mapping per need
  (need key to credential ids). Two layers: an org layer set by package managers
  (org credentials only) and a per-person layer.
- **Trigger mappings:** each trigger instance (enablement) may override a need.
  Trigger credential picks are stored mappings that follow the enabler's
  default, then the org default, then the single usable credential. They are not
  frozen at enable time. A need with no override inherits those defaults on each
  run.
- **When triggers resolve:** enabling resolves nothing and never fails on needs.
  Each run resolves every need in the order below, so a need with no trigger
  override follows the current defaults, and an ambiguous or unbound need fails
  that run with a creation link. Only a need the trigger mapping pins does not
  drift with the defaults. Before each run, a deleted or unusable credential
  named in the instance's trigger mapping pauses the enablement until the need
  is remapped or the credential is usable again; the next event resumes it.
  Unusable refs in a default are skipped. A publish that adds needs while the
  package has live enablements gets a check note.
- **Resolution order:** call map, then trigger mapping, then the person's
  default, then the org default, then auto-resolve (rule 3).
- **Authority is unchanged:** a mapping grants nothing. Runs still need the
  actor's Use plus `package:execute`, and option lists stay filtered by Use.
- **How picks change:** agents propose mapping changes. One Approve on the
  approval page (or the package's Credentials tab for the enabler's own
  instances) applies them. Agents also get an API that can set a trigger
  credential pick only to a value that agent already proposed; that write still
  goes through the same approval path, so no pick changes without approval.
  There is no open-ended `enablementUpdate` or
  `enablementEnable { credentials }` that writes arbitrary picks.
- **Contract:**
  [credential mappings API](../contracts/credential-mappings-api.md).

## Amendment 2026-10-13: credential needs publish pause

Cole and Kent decided how decision 2's pause works.

- **Scope (amended 2026-10-15).** Internet-visible packages only. A publish
  whose credential needs closure (transitive included) adds a need or changes
  one pauses before the new commit becomes published. The previous published
  version keeps running. Private packages publish without this pause; their
  declared credentials still appear when the owner turns internet-visible on
  (`went_public` / capability approval). A first publish, a same-commit publish,
  and a publish that only removes needs do not pause. Host and secret package
  grants (`/connect/secrets`) are unchanged.
- **Approval.** The owner approves on the package's approval page
  (`/@<owner>/<package>/approve-capabilities`), which publishes the paused
  commit. Nothing republishes on its own; a newer push replaces the pending
  request, and a request whose base commit is no longer published is dropped. A
  paused session publish leaves the source branch on the published commit and
  keeps its session; approval re-runs that session's publish at the paused
  commit. A pushed commit is approved through the external-publish path, with
  the paused publish's overwrite options, only while it is still HEAD. Approval
  needs `package:publish` and also counts as the locked-publish approval. A
  locked package keeps its locked-publish flow first; approving that publish
  (`package:write`) runs the pause, so a writer cannot publish new needs without
  the owner.
- **One queue.** The pause shares ADR 0069's approval mechanism: one
  `package_approval_requests` queue and one page, with reason
  `credential_needs_changed` or `went_public`. ADR 0069's own storage-change
  trigger for public apps is unchanged.
- **Surfaces.** Publish tools return `approval_required` with `approval_url` and
  the need changes. Codemods and promote-to-package first publishes skip the
  pause. If the needs cannot be computed, the publish proceeds and the failure
  is reported.

## Amendment 2026-10-15: credential-need enforcement

Kent approved this on 2026-10-14
([#3822](https://github.com/kentcdodds/kody/issues/3822)). Declaring needs
becomes a limit, not only a hint, for packages that someone other than their
author runs.

- **Who is limited.** A run whose package stamp names a package that is not the
  acting person's own. "Own" means all three: the package is in the actor's
  personal org, it is not an unadopted community fork, and it is not
  internet-visible. Team-org packages, runs by Use collaborators, unadopted
  forks, and every internet-visible package are limited. Ad hoc code (no stamp)
  is never limited. A stamped run with no acting person is limited.
- **What counts as declared.** The stamped package's needs closure. A
  `kody.secretMounts` entry does not count; codemod 0013 declares mounted names
  that placeholders fill. `{{secret:NAME}}` and `{{secret-basic:…}}` need a slot
  keyed `NAME` with no kind or kind `secret`. `{{integration-token:NAME}}` needs
  a slot keyed `NAME` with no kind or kind `oauth`. A vault ref
  `{{secret/<provider>:<ref>}}` needs a slot keyed `<provider>` with no kind or
  kind `secret`. Package- and session-scoped placeholders are bound to the
  package already and always count. `credential(key)` / `credentials(key)` need
  `key` in the calling package's own closure; another entry package in the same
  run declaring it does not count. When the stored closure misses, a closure
  recomputed from the package's imports is checked too, so a dependency that
  declared a need after its dependent published still counts (imports resolve
  only within the package's org, and the dependency's new need passed its own
  owner's approval pause). `credential.named` is refused in a limited package.
- **Failure.** An undeclared use fails that fetch or call with
  `credential_need_undeclared`, naming the package by its registry name and the
  key to add. The undeclared credential is never resolved. As with a missing
  secret, a placeholder found in a later chunk of a streamed body fails the
  fetch after earlier chunks were sent.
- **Unchanged.** Placement stays fill-anywhere (a header, the URL, or the body,
  on HTTPS, to a host the credential allows). Use grants, host rules, and the
  publish pause are unchanged. Helpers that resolve a name outside the fetch
  gateway (`secretJwtSign`, `integrationTokenRefresh`, `kody.mcp`, and a webhook
  `secretName`) are not limited yet.
- **Rollout.** The check sits behind the global `credential-need-enforcement`
  flag, off by default. Codemod `0013-declare-credential-needs` declares what
  published packages already use. The flag turns on only after a rescan with
  `scope: 'credential-need-enforcement'` is clean. A package the codemod cannot
  convert is reported instead of being enforced.
- **Self-publish.** An agent's `packageUpdate` (`internet_visible: true`) or the
  settings toggle goes public without the owner's click when the resolved
  capability set is empty (nothing to approve), the package and its whole
  resolved dependency tree declare no credential and no other capability, and a
  security audit with verdict `pass` is recorded for that version. It is
  recorded as the `package.went_public.self_publish` org audit event. The
  credential door then refuses every credential to that package, by any helper,
  until the owner approves going public again — so this does not wait on the
  enforcement flag. Agents cannot self-approve a non-empty capability set. See
  [internet-visible packages](../internet-visible-packages.md#self-publish).

## Amendment 2026-10-16: owner credentials for app visitors

Kent approved this on 2026-10-16
([#3912](https://github.com/kentcdodds/kody/issues/3912)). An internet-visible
package app runs as its viewer: a signed-in org member, or no one (signed out,
or signed in outside the org). Neither can use the org's credentials, so an app
that reads a shared database or sends email for every visitor had no way to.

- **Opt-in.** A `kody.credentials` slot takes `ownerCredentialForVisitors: true`
  (only `true`; there is no package-wide switch). It rides the needs closure
  with the declaring package's value, like `description`. Turning it on counts
  as a changed need, so an internet-visible package's publish pauses for
  approval; turning it off does not.
- **Approval.** Each opted-in need's candidates are their own capability-set
  entries, carrying `needKey` and the flag, and they enter the fingerprint
  (entries without the flag hash as before, so existing pins do not move). The
  approval page says on each such credential that visitors may use it through
  the app, signed out or signed in as someone else. Who may approve is
  unchanged: a person with `package:publish`, never an agent.
- **Authority.** In a package-app run only, `credential(key)` /
  `credentials(key)` for an opted-in need resolve as the person who approved the
  app's latest capability set, with the role they hold in the owning org now
  (live user and org binding, like a trigger's enabler). It applies only while
  the app is internet-visible, the run serves that approval's commit, and the
  picked credentials are among those the approval listed for the key; the
  viewer's `credentials` call map never picks for it. A republish that
  `resolveInternetVisibleApprovedCommit` accepts keeps the same approver. If the
  app is private or the commit is not the approved one, the need opens as the
  viewer. If the approver can no longer use the org's credentials, or the need
  resolves to an unlisted credential, it fails with `credential_denied` until an
  owner approves again.
- **Viewer stays separate.** The run's viewer is unchanged for everything else:
  other needs, placeholders, by-name helpers, and the app's own authorization.
  The authority never becomes the run's user. The client handle is signed with
  the flag and checked against the authority on each use.
- **Abuse.** Each use whose viewer is not the authority is rate-limited per org,
  app, and credential (300 per minute; every non-owner viewer shares one budget
  so one-time visitors cannot grow the limiter table) and fails with
  `credential_rate_limited`. Its `credential.resolve` audit row is attributed to
  the authority and adds `ownerCredentialForVisitors`, `appPackageId`,
  `credentialAuthorityUserId`, `viewerUserId`, and `viewerKind` (`person` or
  `anonymous`).
- **Unchanged.** Credential-need enforcement and the self-published package
  guard still apply; a self-published app gets no credentials either way.

## Amendment 2026-10-16: stamped packages fail closed

Kent approved this on 2026-10-16
([#3836](https://github.com/kentcdodds/kody/issues/3836)). Phase 2 left
published packages that cannot be sealed. Those packages keep running. Turning
on the global `credential-need-enforcement` flag would limit them too, so the
flag stays off.

- **Who is limited.** A package whose current published commit has a stored
  credential stamp (`credential-stamp.json` next to the published artifact). The
  limit applies to every run of that package, including its author's. Ad hoc
  code and packages with no stamp are not limited by this rule. A stored blob
  that is not a valid stamp fail-closes (treated as stamped). A missing blob
  stays on the legacy path.
- **What counts as declared.** The same needs closure as the 2026-10-15
  amendment: the package's `kody.credentials` slots, including needs its imports
  declare. A use the stored closure misses is checked again against a closure
  recomputed from imports.
- **Where it is checked.** `credential(key)` / `credentials(key)`, fetch
  placeholders, vault placeholders, `secretJwtSign`, and `packageSecrets` mount
  reads (the resolved mount name, not the alias). A `kind: "signing"` slot fills
  a secret use, so an existing signing declaration still covers `secretJwtSign`.
  Literal `kody.mcp.SERVER` capabilities check the server name as a credential
  key. `integrationTokenRefresh` checks the integration name.
  `credential.named()` is refused. Webhook enablement `secretName` / integration
  picks (including webhook 401 refresh), and id-based credential-client uses
  that already passed the key check, stay on the legacy access path so live
  webhooks and declared client uses keep working.
- **Unstamped packages.** Unchanged: implicit user-secret read, author
  exemption, and the global flag (off). Owners convert by republishing through
  the publish gate. There is no forced migration and no owner email.
- **Flag.** Do not flip `credential-need-enforcement` to mean "phase 3 is on".
  Stamped packages are enforced because a stamp is stored, not because the flag
  changed.

## Amendment 2026-10-17: per-credential fill placement

Kent approved this on 2026-10-17. It reverses the permanent "no header-only
switch" rule for Key placeholders (lines 115–117 and 408–410 above, and the
2026-10-15 amendment's "Placement stays fill-anywhere").

- **What changes.** Every credential that fills placeholders (`{{secret:…}}`,
  `{{secret-basic:…}}`, `{{integration-token:…}}`, vault `{{secret/…}}`) gets an
  allowed **fill placement**: which request parts it may be filled into —
  headers (optionally limited to named headers), query, URL path, and/or body.
  Stored as `placement_json`. **Null/absent means anywhere** (today's behavior)
  so existing rows do not change when the column lands. New credentials will
  default to headers-only once observe-mode ships. The per-request header
  `x-kody-secret-resolution: headers-only` stays and **intersects** with
  placement (it never widens it). Distinct from `inject`, which only steers the
  scoped `credential()` client.
- **Rollout.** (1) Schema + read/write + audit of placement changes, no gateway
  behavior change. (2) Observe mode logs "would block" (placeholders and scoped
  `credential()` inject targets) and new credentials default to headers-only.
  (3) Surfaces (UI, MCP, CLI, docs) — credential detail fill-placement editor,
  secret create/edit, `secretSet` / `credentialUpdate` / `secretList` placement,
  guides, and the publish/`kody dev check` warning for variable header helpers.
  (4) Migrate existing credentials from observed package usage and audit logs
  (including package-scope rows that still have the headers-only default from an
  earlier insert, not only rows that still have null placement). (5) Enforcement
  with a clear refusal that names the credential, the refused part, and the
  allowed parts. Enforcement ships last. Steps 4 and 5 shipped in
  [Amendment 2026-10-27: placement enforcement](#amendment-2026-10-27-placement-enforcement).
- **Unchanged.** Host allowlists, HTTPS-only fill, scoped-client `inject` shapes
  (header / basic / query), and the rest of this record. Package need
  declarations may optionally carry fill placement (see
  [Amendment 2026-10-20](#amendment-2026-10-20-package-manifest-fill-placement)).

## Amendment 2026-10-20: package manifest fill placement

Cole folded this in from free-tier feedback on `@danj/audible-auth` (body-filled
refresh tokens) before steps 4 and 5 of the placement rollout. It does not ship
auto-narrowing or enforcement.

- **What changes.** A `kody.credentials` need may declare optional `placement`
  (same shape as credential fill placement: headers / query / path / body). When
  a package-scope secret for that name is **inserted** (Connect, `secretSet` /
  `secretSetMany`, or account save when no row exists yet), the published
  declaration is written as `placement_json` instead of the headers-only
  default. Omitted declaration keeps headers-only. Updates to an existing row do
  not rewrite placement from the manifest. Disconnect clears the value but keeps
  the row and placement; reconnect with `secretSet` fills the same record so
  preserved placement wins over the manifest. Delete removes the credential; a
  later Connect is a new insert that can apply the declaration again.
- **Least privilege.** Package runtimes still cannot pass `placement` on
  `secretSet` or call `credentialUpdate`. Widening requires a reviewable publish
  (and Promote on a locked package), then Delete+Connect (new insert) or the
  credential detail editor. Disconnect+reconnect preserves placement and does
  not re-apply the manifest. The credential detail fill-placement editor already
  covers package-scope secrets (listed as org-owned rows with a `packageId`);
  the owner can narrow or adjust after insert.
- **Step 4 note.** When auto-narrowing ships, it must also consider
  package-scope rows that received headers-only before a body (or other)
  declaration existed, not only null (anywhere) rows.

## Amendment 2026-10-24: package apps run as their publisher

Kent approved this on 2026-10-24. It replaces the viewer rule of the
[2026-10-16 amendment](#amendment-2026-10-16-owner-credentials-for-app-visitors)
for package apps. An app runs as one person, who pays for it and whose
credentials fill its needs. Visitors bring only verified identity.

- **Who.** An explicit runs-as person an Owner picks, else the person who last
  published the app, else the owner of a personal org. A publish with no known
  person clears the recorded publisher. The person is checked live (member of
  the owning org, account usable) on every call and fails clearly when not.
- **Cap.** Only Kody capabilities the app lists in `kody.app.capabilities` run
  as that person, within the role they hold now. Credential needs stay capped by
  credential-need enforcement.
- **Visitors.** Identity is id, username, and role for members; email only under
  the `email` scope. `kody.app.visitorNeeds` gives one Sign in with Kody consent
  scope per need (`need:<key>`) for work on the visitor's own data, checked live
  on every call and never falling back to the runs-as person. Usage stays
  attributed to the visitor.
- **Fallback.** A call that would fail as the runs-as person but worked as the
  visitor still runs as the visitor and records a would-break row (app, call
  name, kind, hashed visitor), counted with
  `adminPackageAppAuthorityFallbackReport`. A call refused as not declared
  (including `credential.named`) that also fails as the visitor is a hard
  rejection: the app sees the error, and a row with the same key lands in
  `package_app_authority_rejections`, reported as `hardRejections` in the same
  report. The visitor path and `ownerCredentialForVisitors` are removed only
  after both stay at zero.
- **Declarations.** How declarations cover imported packages, the publish check,
  and the cleanup schedule are in
  [0089](./0089-packages-declare-capabilities.md).

## Amendment 2026-10-27: dependency needs use the entry package's mappings

Kent decided this on 2026-10-27 after a user report: a dependency's
`credential(key)` ignored the mapping its entry package showed as ready.

- **Rule.** When dependency D calls `credential(key)` or `credentials(key)` in a
  run whose entry package E pins the need, stored mappings (the run's trigger
  mapping, then `mine`, then `org`) and the creation link's `forPackage` come
  from E. E is where `packageGet`, the capability set approval, and the
  Credentials tab already show and set the mapping, and the only package a
  caller in another org can map.
- **Which entry.** The first entry whose pinned closure has the key, the same
  first-entry-wins rule `loadRunCredentialNeeds` uses for the need definition. A
  caller that is itself an entry reads its own mappings. Ad hoc code with no
  package reads none.
- **Identity split.** GHSA-5fv3 bound identity still decides authorization:
  declared use is checked against D's own closure (the
  [2026-10-15 amendment](#amendment-2026-10-15-credential-need-enforcement)),
  and a Key bound to a package fills only that package's own calls. The entry is
  used only to select mappings, and comes from the host: the run's package
  context or, for CLI `--local`, the entries the package graph signs into each
  package binding. Sandbox code cannot name it. E's code can already open any
  key in its closure, and a mapping never grants Use, so reading E's mappings
  for D's need grants nothing new.

## Amendment 2026-10-27: secret-provider slots

Kent decided on 2026-10-27 that saved packages must be able to use custom secret
provider placeholders, and that the slot names the provider package. Before
this, the publish stamp failed every vault placeholder in a request site, and no
manifest declaration could satisfy it.

- **Shape.** A `kody.credentials` slot with `kind: "secret-provider"`, a
  required `package` (the saved provider package's package.json name), and a
  description. The key follows the normal key grammar. `provider` and the
  saved-credential fields (`multiple`, `supplier`, `required`,
  `ownerCredentialForVisitors`, `placement`) are rejected.
- **Publish.** The gate looks up `package` in the publishing org and reads its
  `kody.secretProvider.id`. A vault placeholder in a request or
  credential-mapped site stamps only when its literal provider id equals that
  id; the slot key is sealed. A missing, unreadable, or id-less package fails
  publish, as do computed provider ids and ids no declared package serves.
  Display-only placeholders stay exempt.
- **Runtime.** A provider use is declared only when the org's binding for the
  placeholder's provider id is the declared package; otherwise it fails with
  `credential_need_undeclared` naming the bound and declared packages. An older
  slot keyed by the provider id still counts. Saved-credential uses
  (`credential(key)`, `{{secret:NAME}}`) never resolve through a secret-provider
  need.
- **Unchanged.** The stamp seals the provider, not refs. The binding check,
  per-package per-ref grants, item websites as hosts, `https:` only, and
  redaction all still apply. Mappings, call maps, candidates, and creation links
  skip secret-provider needs.

## Amendment 2026-10-27: widening placement and changing inject are website-only

Kent decided on 2026-10-27 that code running with a credential's authority must
not be able to move its value somewhere new. Before this, `credentialUpdate` and
`secretSet` let ad hoc `execute` widen placement (for example add `body`) or
point inject at a different header or query parameter.

- **Refused.** Widening fill placement (null, or any request part or header name
  the stored placement lacks) and any inject change, from hosted `execute`,
  `execute --local`, package code, and app code. The refusal names the
  credential and links to its page on the website.
- **Signal.** The same host-set caller signals as the CLI bootstrap refusal:
  hosted execute has no `openApiPrincipal`, the local CapabilityProxy sets
  `localExecuteHop`, and package or app runtimes carry their storage context.
  None of them comes from module arguments.
- **Allowed.** Narrowing placement and provider changes, from every caller. The
  website (credential page and account secret editor) and the MCP `api` tool
  keep full edits. New credentials created from code may keep the defaults
  (headers-only, `Authorization: Bearer`) or narrow them.

## Amendment 2026-10-27: placement enforcement

- **Context.** Fill placement shipped observe-only (steps 1 to 3 of
  [Amendment 2026-10-17](#amendment-2026-10-17-per-credential-fill-placement)).
  A credential with no placement filled anywhere, including the query, URL path,
  and body, where a host may store what it receives.
- **Decision.** The fetch gateway enforces each credential's placement on every
  fill path (placeholders, secret providers, managed integration tokens, and the
  scoped `credential()` client). The refusal names the credential, the refused
  part, and the allowed parts, and never the value.
- **Owner opt-in.** Headers follow the stored placement. Query, URL path, and
  body also need a per-credential owner opt-in
  (`credential_fill_placement_opt_ins`), recorded when the owner saves those
  parts on the website, which shows a warning that the host may store the value.
  Placement set from code or a package manifest stores the parts but does not
  opt in. This covers a declared host that legitimately needs the secret in a
  stored body field, the one case handles cannot.
- **Legacy credentials.** A credential with no placement (null) fills headers
  plus each query, path, or body part it was seen filled into before enforcement
  (`credential_fill_placement_observations`). Migration 0195 copies those parts
  into `observed` opt-ins, so nobody migrates anything by hand.
- **Grandfathered fills.** Migration 0195 grants the `observed` opt-in to every
  credential seen filling a query, path, or body part before enforcement,
  including placements set from code or a package manifest, so every fill that
  works today keeps working. It never widens a credential past its stored
  placement. Placements set from code after 0195 still need the owner opt-in.
- **Not built.** A per-host path allowlist; it comes later only if abuse shows
  up.

## Amendment 2026-10-27: derived tokens come back sealed

Kent decided on 2026-10-27 that a token Kody derives with a credential is a
value code must not hold, the same as the credential. Before this,
`oauthClientCredentials` returned the provider's raw token payload (with a
best-effort redactor on hosted runs only), `secretJwtSign` returned the signed
JWT, and a manual token request returned whatever the token endpoint sent.

- **Sealed tokens.** `access_token`, `refresh_token`, and `id_token` in a JSON
  response to a request the fetch gateway filled a credential into, and the
  `secretJwtSign` JWT, come back as an integration-token placeholder whose name
  is the token encrypted by the host (AES-GCM, key derived from
  `SECRET_STORE_KEY`). Code passes it into a fetch header or body
  (`Authorization: Bearer ...` keeps working) and the gateway opens it on
  egress.
- **Bound.** A sealed token fills only for its org, in the run that received it
  (the run's credential-client binding, or the CapabilityProxy credential for
  `--local`), on the registrable domain of the token URL or of any approved host
  of the credentials filled into the token request (so a token minted on a
  separate auth domain still reaches the API the credential is approved for,
  with no new `oauthClientCredentials` option), or of the JWT's https `aud` or
  `send_to_host`, never in a URL query or path, and for at most one hour. A JWT
  with neither an https `aud` nor `send_to_host` stays sealed and org-bound but
  may fill on any host, so existing callers keep working; the result carries a
  deprecation `warning`, and requiring `send_to_host` is tracked in
  kody-hq/kody#4456.
- **Refresh tokens.** A sealed `refresh_token` shares the one-run, one-hour cap.
  Kody holding refresh tokens server side is tracked in kody-hq/kody#4457.
- **Server-side.** `oauthClientCredentials` runs its token request through the
  gateway, hosted and `--local`. The `__kodyTrackRunSecret` redactor hop is
  gone; nothing derived reaches code to redact.
- **Unchanged.** Kody-managed integration refresh (`integrations/token-refresh`)
  already runs on the host and does not go through the gateway.

### 2026-10-28: an access token also fills on its audience

The first cut broke every identity provider whose token host is not the API host
(Azure Entra at `login.microsoftonline.com` for `management.azure.com`; Google,
Okta, and Auth0 custom APIs) unless the client secret was approved for the API
too, which widens where the secret itself may go. Kent kept
`oauthClientCredentials` free of a `send_to_host` option, so a sealed
`access_token` that is a JWT also fills on the host its https `aud` names:

- **Why it is safe.** The identity provider chose `aud`; code only asked for a
  scope or resource. A token is only good at its audience, so sending it there
  is the use it was minted for. A token for an attacker's audience gives the
  attacker a token only that attacker accepts, never the secret or another API's
  access.
- **Exact host.** `aud` adds its exact host, not its registrable domain or
  subdomains, so an `https://management.azure.com` token does not fill on
  `<label>.<region>.cloudapp.azure.com` or `evil.management.azure.com`.
- **One outside audience.** A JWT naming more than one https audience outside
  the token and approved domains gets none (an `aud` like Auth0's `userinfo` on
  the token domain does not count), so a multi-audience token cannot carry one
  API's access to a second host.
- **Not an echo.** A token whose text contains a value Kody filled into the
  request, or the decoded password of a filled Basic credential (an endpoint
  that echoed the secret), gets no audience host. Decoded JWT claims are not
  searched: real tokens carry the client id (Entra `appid`), and an approved
  host that re-encodes the secret already holds it.
- **Opaque tokens.** A token that is not a JWT with an https `aud` keeps the
  token and approved domains. Kody does not read the requested `scope` or
  `resource`: code wrote those, so they cannot vouch for where the token goes.
  The refusal says so and names the fix (a JWT access token whose `aud` is the
  API, or approving the API on the credential).
- **Documented aliases.** Entra resource identifiers Microsoft serves at another
  host also fill there: `api.loganalytics.io` on `api.loganalytics.azure.com`,
  and `management.core.windows.net` on `management.azure.com`. Add a pair only
  when Microsoft documents it.

### 2026-10-28: a sealed token can be saved as a Key

Sealing broke every flow that keeps a long-lived token a token exchange returns.
Plaid's `/item/public_token/exchange` `access_token` came back sealed, so
`secretSet` stored the `kody-sealed.…` text, which only works in the run that
received it, and Plaid later answered `INVALID_ACCESS_TOKEN`. Kent asked for a
sanctioned path:

- **`secretSet({ name, scope: 'user', sealed_token })`.** The host opens a
  sealed token from the current run (same org, run-binding, and expiry checks as
  a fill) and saves the real token as a user-scope Key through `saveSecret`, so
  the value is encrypted and audited like any Key and never returned. It works
  hosted, `--local` (the CapabilityProxy binding matches the gateway's), and
  through the Open API route, where an Open API caller has no run and is refused
  as another run.
- **Hosts.** A sealed token now records exact save hosts: the token URL host and
  the filled credentials' exact (non-wildcard) approved hosts. The Key gets
  those plus the token's `aud` hosts. Keys match hosts exactly, so the Key is
  never wider than the sealed token's registrable domains.
- **Placement.** The Key's placement is headers and body, with the body opt-in
  recorded as source `sealed_token` (migration 0199), not `owner`. A sealed
  token already filled the body. The URL query and path stay refused because
  hosts log URLs.
- **No new approval.** The owner approved the hosts on the credentials that
  minted the token, and saving does not widen where it goes. The write is
  audited as `credential.kind_set` with `savedFrom: 'sealed_token'`, plus the
  usual created/value-replaced row. An existing name that is not a Key is
  refused. Replacing an existing Key (re-linking a Plaid Item) never widens it:
  its hosts and placement become the overlap of the Key's and the sealed
  token's, its opt-ins stay as the owner left them, and no overlap is refused.
- **Refused.** A token from another run, another org, or past its expiry; a
  `secretJwtSign` JWT (sign a new one when needed); a token whose text repeats a
  credential filled into its request (an echo, the same check that drops
  audience hosts); a token sealed before save hosts existed; and package
  runtimes, which cannot create user secrets. A `value` (or `secretSetMany`
  value) that contains `kody-sealed.` is refused with a pointer to
  `sealed_token`.
- **2026-10-29: package refusals point to `login`.** No decision change: package
  runtimes are still refused. A package caller that passes a sealed token as
  `value` (either scope, `secretSet` or `secretSetMany`) or as `sealed_token`
  (any scope) now gets one message that points to a `login` credential holding
  the refresh token (Kody runs the token request and caches the session) or to
  using the sealed token only in its run, instead of the `scope: 'user'` and
  "save it from execute" advice that sent package authors in a circle. Persisted
  package-held tokens remain open
  ([kody-hq/kody#4457](https://github.com/kody-hq/kody/issues/4457)).

## Amendment 2026-10-28: owner placement approval links

- **Context.** A new user Key for a body-auth API (Plaid) was approved for its
  host through `/connect/secrets` but kept the headers-only default, so every
  fill failed with `credential_placement_refused` and the owner had to find the
  placement setting by hand. Agents correctly cannot widen placement.
- **Decision.** Agents can ask, never approve. `/connect/secrets` takes
  `placement=query,path,body` (with or without `hosts`); the owner sees the
  credential, the parts, the hosts, and the "host may store this" warning, and
  one approval allows the hosts and widens the stored placement. The opt-in it
  records is `owner` and covers exactly the requested parts plus parts already
  opted in; parts set from code that the owner never saw stay un-opted. A legacy
  (null) placement becomes explicit: what it already fills, plus the requested
  parts.
- **Errors carry the link.** A query, path, or body refusal of a user Key the
  run org owns carries its approval link (with the request host). Other refusals
  link to the credential's fill placement setting,
  `/@<org>/-/credentials/<credential>#fill-placement`, which opens the editor.
- **Agent surface.** `credentialPlacementApprovalLink` (MCP `api`, Open API
  `POST /v1/credential-placement-approvals`, `kody api`) returns the link and
  whether anything is pending. It is read-only.

## Amendment 2026-10-29: placeholders and createAuthenticatedFetch resolve granted personal credentials

- **Context.** #3727 made placeholders and scoped `credential()` clients share
  one personal-grant rule, but user docs still said `{{secret:NAME}}`
  placeholders never resolve a personal credential, and name-based
  `createAuthenticatedFetch(name)` pre-read its config through the org-only
  `integrationGet`, so a granted personal OAuth connection failed with "not
  found" even though the token gateway would have filled it.
- **Decision.** In a run org, `{{secret:NAME}}` and `{{integration-token:NAME}}`
  placeholders resolve the same set scoped clients do: the org credential of
  that name first, else the actor's own personal credential of that name granted
  to the run org (live grant, actor is the owner, live org binding,
  `integration:use` / token scope, package allowlist on the owning org). Nobody
  else can use it, Owners and Automation included.
- **createAuthenticatedFetch.** Its config read follows the same rule through a
  host-only runtime helper that shares the gateway's lookup
  (`findIntegrationLookupByName`) and checks. It returns only `name`,
  `apiBaseUrl`, and `requiredHosts`; tokens and refresh stay host-side. The
  public `integrationGet` capability stays run-org-only.

## Amendment 2026-10-29: personal connections through an org's OAuth app

Builds the rule in [Credential fields](#credential-fields) that "a personal
OAuth credential minted through an org's OAuth app is pinned to that org", and
the [Lifecycle](#lifecycle) rule that pinned credentials are wiped and revoked
upstream when org access ends. Kent's decision: **the person owns a personal
connection made through an org's OAuth app. Org admins can list and revoke it,
but never use it or read its tokens.**

- **Storage.** `user_integrations.app_owner_id` names the org whose OAuth app
  (client id and secret) the connection uses. `NULL` means the connection's own
  org, so every earlier row keeps its meaning. The connection, its tokens, and
  its audit trail live in the person's personal org; the client secret stays in
  the org's app and is read host-side for exchange, refresh, and revoke only.
- **Connecting.** `/connect/oauth?org=<org>&app=<app>&mode=personal`. It needs a
  live binding to that team org with the Member or Owner role. It is not
  `integration:use`, which is a per-credential grant: the member uses their own
  account, not an org credential. Billing members and outside collaborators are
  refused. The member never sees, edits, or copies the client secret.
- **Pinning.** Saving it grants it to the app's org automatically.
  `credentialOrgGrant` refuses every other org. It resolves (placeholders,
  `credential()` clients, `createAuthenticatedFetch`, refresh) only in runs of
  the pinned org whose actor is its owner: never in the owner's personal org,
  another org, another member's runs, or for Owners or Automation on the owner's
  behalf.
- **Admins.** `integrationMemberConnectionList` and
  `integrationMemberConnectionRevoke` (Open API
  `/v1/oauth-apps/member-connections`, website app page) need
  `integration:manage_access` org-wide, which only Owners hold; a grant on one
  integration does not reach members' connections. The list shows member, app,
  account label, and dates, never tokens or scopes. Revoke wipes the connection
  and its grant, then revokes upstream; it is audited in the org
  (`credential.pinned_connection_revoked`) and in the owner's personal org
  (`credential.pinned_connection_wiped`). Revoking never gives the admin the
  token.
- **Cut-off.** Leaving or removal (`offboardOrgMember`) and deleting the org's
  app wipe every connection pinned to it and revoke upstream first, so deleting
  the app is never blocked by members' connections.
- **Upstream revoke.** GitHub OAuth Apps:
  `DELETE /applications/{client_id}/token` with the app's client credentials.
  Providers with an RFC 7009 endpoint: a revocation request for the refresh
  token, else the access token. Otherwise nothing upstream is revoked and the
  outcome says so. An upstream failure never blocks the local wipe; it is logged
  and audited without token material.

## Amendment 2026-10-29: `login` is Kody-managed OAuth refresh

Kent decided on 2026-10-29 that the `login` kind becomes Kody's platform-managed
OAuth refresh, and that #4457 folds into it. Kody holds the refresh token, runs
the token request on the host, keeps the access token encrypted on its side, and
fills it on the credential's hosts; code never holds either token, and there is
no package-scoped storage for sealed tokens. The full record (persisted
sessions, single-flight, 401 retry, rotated refresh tokens, and saving a sealed
refresh token as a login credential) is
[ADR 0090](./0090-login-credentials-are-kody-managed-oauth-refresh.md). A sealed
refresh token saved that way goes only to the sealed token's save hosts, like a
sealed token saved as a Key (2026-10-28), and package code still cannot save
one.
