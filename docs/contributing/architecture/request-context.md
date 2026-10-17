# Request context

Every request Kody serves carries one `RequestContext`
(`packages/shared/src/request-context.ts`), whatever reached it: a browser
session, MCP, the CLI, an API token, a package app, a schedule, a webhook, an
inbound email, or a platform event. It answers four questions in one shape:

| Field         | Question                                   | Answer                                                                          |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `org`         | Whose data does this touch?                | The request's resolved org (`id`, `slug`); personal orgs reuse `stable_user_id` |
| `actor`       | Who is acting?                             | The signed-in person; `null` for Automation                                     |
| `attribution` | Who is the run billed and audited to?      | `user` or `automation` (source + source id)                                     |
| `credential`  | What authenticated it, and does it narrow? | Kind, id, bound org, scopes, profile name                                       |
| `membership`  | Which org role does the actor hold?        | `owner`; `null` for Automation                                                  |

Org ids are `OwnerId` and actors are `PersonId`
([ADR 0060](../decisions/0060-owner-and-person-ids.md)). Org ids are internal:
public surfaces show `org.slug`, never `org.id`.

## Where it comes from

Nothing builds a `RequestContext` by hand. Every caller context names how the
request arrived, and `deriveRequestContext`
(`packages/worker/src/request-context/request-context.ts`) turns that
`RequestSource` into the context:

```ts
const callerContext = createMcpCallerContext({
	baseUrl,
	user,
	storageContext,
	source: { kind: 'api-token', tokenId: record.id },
})
callerContext.request // RequestContext | null (null only without a user)
```

`source` is required, so a new entry point does not compile until it says what
it is. The browser equivalent is `AuthenticatedAppUser.request`
(`{ kind: 'session' }`).

| Source                                | `source`                                 | Actor     |
| ------------------------------------- | ---------------------------------------- | --------- |
| Browser session                       | `session`                                | Person    |
| MCP OAuth (both lanes)                | `mcp-oauth`                              | Person    |
| CLI / local execute                   | `cli`                                    | Person    |
| Open API token (`api.kody.codes`)     | `api-token` (token id)                   | Person    |
| Package app HTTP, realtime, bridge    | `package-app`                            | Person    |
| Scheduled job                         | `schedule` (job id)                      | none      |
| Webhook delivery                      | `webhook` (endpoint id)                  | none      |
| Inbound email subscription            | `inbound-email` (inbox id, sender)       | Sender\*  |
| Platform topic subscription           | `platform-event` (source label)          | none      |
| Nested invoke, run-now, workflow step | `inherited` (the starting run's lineage) | Inherited |
| Emitted package event, retriever      | `inherited`                              | Inherited |
| Sealed secret provider                | `inherited`                              | Inherited |

\* `classifyInboundEmailSender` (`packages/worker/src/email/inbound-sender.ts`)
sets `sender`. A verified org member is `member`; any other sender whose From
authenticated (DMARC pass or aligned SPF, never DKIM-only) is `inbox-owner`.
Packages run only through a matching per-sender enablement, as that enablement's
enabler. Attribution stays Automation (`email`) either way, so the inbox's org
is billed. Unverified mail never builds a source: it runs nothing.

`inherited` carries a `RequestLineage` (actor, attribution, credential,
membership). Membership is the starter's role in its own org, so a downstream
run that executes as the org's identity does not lift a Member to Owner; lineage
written before membership existed keeps the role of the run's identity only when
the actor is that identity (a personal org's owner); any other actor gets no
role. The org is never inherited; it is re-resolved for the identity the run
uses. Lineage crosses durable boundaries as JSON: workflow payloads (`lineage`,
kept out of instance-id hashing), package event queue messages (`lineage`), and
the jobs worker run-now RPC. Readers re-validate it with `parseRequestLineage`.
A payload written before lineage existed runs as Automation, which can only
narrow what the starter could do.

## The one swap point

`deriveRequestContext` chooses org binding from an optional DB-backed
`orgBinding`. Browser sessions load the person's personal org
(`loadOrgBindingForPerson`). MCP OAuth and the CLI OAuth Open API path load the
org stamped on the grant (`props.orgId`, then `loadOrgBindingForOrg`), falling
back to `props.userId` as the personal org id when the grant has no `orgId`
([0064](../decisions/0064-oauth-org-binding.md)). Call sites that omit
`orgBinding` use `resolveOrgBinding` → `personalOrgId(user.userId)` with slug
from username (covers sync paths and tests). Call sites pass `orgBinding` only;
they do not reimplement membership rules.

The persisted caller context (job `caller_context_json`, MCP agent props) stays
wire-shaped: `request` is derived, never serialized (`toMcpCallerContextWire`,
`parseMcpCallerContextWire`).

## Storage keys

Org-owned storage and usage billing read `ownerIdFromCaller`
(`packages/worker/src/request-context/owner-id.ts`): `request.org.id` when the
request has an org, otherwise the acting person. Personal orgs reuse the person
id, so those keys do not move. Package import lookup, account resource pages,
secrets, jobs, and execute usage go through that function.

The URL is the source of the website's organization scope. Native route loaders
pass the matched org slug explicitly to Start server functions, which resolve
membership against the original authenticated request. They do not infer scope
from Referer or remember a current org in a cookie. Pages without org scope use
the personal organization, and links to team resources carry their slug.

Native collection readers also enforce section permissions. The document-level
org guard rejects inaccessible org routes before rendering. Each server function
independently checks its scope and permissions, since RPC calls can bypass page
navigation.

## What to read when changing it

- `packages/shared/src/request-context.ts`: the shape
- `packages/worker/src/request-context/request-context.ts`: sources, derivation,
  lineage parsing
- `packages/worker/src/mcp/context.ts`: caller context construction
- [Authorization](./authorization.md): `authorize`, which reads this shape, and
  site-admin RBAC, a separate system
