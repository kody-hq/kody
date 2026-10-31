# Secret Host Approval Policy

This document describes the required policy for outbound requests that use saved
secrets.

## Rule

Allowed outbound hosts for a secret are privileged policy, not normal secret
metadata.

Those policies must not be created, widened, or modified by:

- MCP tools
- execute-time sandboxed code
- package app code
- capability handlers that serve agent-driven secret creation or update flows

Allowed outbound hosts may only be changed through the authenticated account
admin UI.

In this repo, that means the user must approve host access through the
authenticated **`/connect/secrets`** page (query params `name` / `names` and
`hosts`). Package grants live on `/@<slug>/-/secrets/approve`.
`/@<slug>/-/secrets` also renders an approval card when the request includes
host or package approval query params.

## What agents should assume

Agents should assume a secret starts with an empty host allowlist unless the
user has already approved one or more hosts in the admin UI.

Saving or updating a secret value does not authorize sending that secret to any
host.

If an outbound request uses a placeholder such as `{{secret:name}}` and the
target host is not already approved for that secret, the correct behavior is:

1. Stop retrying.
2. Show the user the approval link from the error.
3. Ask the user whether they want to approve that host in the admin UI.
4. Retry only after the user approves it.

The same stop-and-surface rule applies to package secret access denies. When
several secrets or hosts need approval together, prefer the bulk host approval
URL (`/connect/secrets?names=...&hosts=...`) or the bulk package approval URL
(`/@<slug>/-/secrets/approve?package_id=...&names=...`) over one link per
secret. Agents must never auto-approve host or package access.

## Placement in the same approval

Filling a credential into the query, URL path, or body needs a per-credential
owner opt-in (ADR 0068), because the host may store what it receives there.
`/connect/secrets` takes an optional `placement` parameter (`query`, `path`,
`body`, comma-separated) so a new secret for a body-auth API can be set up in
one step:
`/connect/secrets?name=plaidSecret&hosts=production.plaid.com&placement=body`.
`hosts` is optional when only placement is requested. The page shows the
credential, the requested parts, the hosts, and the "host may store this"
warning; one click approves both, and nothing changes on decline.

Agents build the link (`credentialPlacementApprovalLink`, or the link a
`credential_placement_refused` error already carries) and hand it to the owner.
They never approve it: approval is a website mutation only.

## Host shape

`/connect/secrets` (and the Allow write) treat each `hosts` value as a hostname
token, not free-form text. The same helper classifies hosts on the approval read
path and again before `allowedHosts` is written, so the UI and persistence
cannot diverge.

A host is **valid** when, after the existing `normalizeHost` cleanup (trim,
lowercase, strip `http(s)://` and take `URL.hostname` for full URLs), it is:

- a dotted DNS hostname whose public suffix is ICANN, a private PSL entry, or an
  RFC 2606 special-use suffix (`test`, `example`, `invalid`)
- `localhost` or a `*.localhost` name
- an IPv4 or IPv6 address (shape only — not a policy allow/deny for private
  networks). IPv6 is stored as `URL.hostname` serializes it (`[::1]`), so Allow
  and later fetch matching use the same token

A host is **rejected** (shown as invalid, never written) when it is:

- empty or whitespace-only (dropped before classification)
- path-bearing or otherwise malformed (`api.openai.com/v1`, embedded spaces,
  userinfo, a leftover path or query, a bare label such as `openai`)
- a dotted name whose public suffix is not in the lists above (`api.ope`,
  `api.o`) — the usual leftover when a terminal soft-wraps a long approval URL

Rejected hosts appear on the approval page with an explanation that the link may
have been truncated. **Allow** only grants the valid hosts. **Allow all N
hosts** is offered only when every listed host is valid; mixed lists use **Allow
N valid hosts** and never report unqualified success while rejected hosts
remain.

This is host-shape validation only. Look-alike FQDNs, homoglyphs, and
first-party API allow/deny lists are out of scope.

## What agents must not do

Do not design or document any MCP capability, package app helper, or client
library that allows agent-controlled writes to a secret's allowed hosts.

Specifically, do not:

- add `allowed_hosts` or equivalent fields to MCP-facing secret create/update
  inputs
- imply that a package app can self-authorize a host just because it can save a
  secret
- imply that execute-time code can widen egress permissions
- treat host approval as ordinary secret metadata editing

If a workflow would be smoother by auto-approving a host, the fix should be
better guidance, helper APIs, or UX around the approval flow, not a new write
path that bypasses the admin UI.

## Guidance for capability authors

When writing capability descriptions or agent-facing docs:

- say explicitly that secret save/update does not grant outbound use
- say explicitly that only the authenticated account admin UI can approve hosts
- tell agents to inspect secret metadata before making a secret-bearing request
- tell agents to surface the approval link and stop on deny

This policy is especially important in:

- secret create/update/list capabilities
- execute-time fetch documentation
- package app documentation
- OAuth and other hosted callback examples

## Guidance for package app flows

Package apps may:

- collect secret values from the user
- save those values as secrets
- save and read public configuration from package storage or the package repo
- inspect secret metadata, including current allowed hosts
- present approval links returned from blocked requests

Package apps may not:

- set allowed hosts directly
- bypass the admin approval route
- silently retry secret-bearing requests after a deny

When a package app hits a recoverable runtime problem, it should:

1. Show the problem in the UI.
2. Include the next action the user should take, such as approving a host,
   providing a missing non-secret value, or retrying after a fix.

OAuth client credentials and tokens live on the integration, not in the secret
store. Send the user to **`/connect/oauth`** and use
**`createAuthenticatedFetch`** / **`integrationTokenRefresh`** after connect.
See [OAuth: bring your own app](../guides/oauth.md).

For secret-backed fetches (API keys, PATs, webhook HMAC secrets), prefer this
sequence:

1. Save the credential as a secret (`/connect/secret-set` or `secretSet`).
2. Attempt the outbound request with secret placeholders.
3. If the request is blocked on host approval, send the user to
   `/connect/secrets`.
4. Retry after approval.
