# 0064 — OAuth consent binds a grant to one org

- **Status:** accepted
- **Date:** 2026-10-09

## Context

Teams phase 4 binds credentials to an organization. MCP OAuth is one full-access
grant ([0049](./0049-no-mcp-capability-oauth-scopes.md)); connection profiles
narrow which packages that grant can touch, they are not a permission menu.
Every person already has a personal org ([0063](./0063-teams-expand-orgs.md)). A
later team org must not silently inherit a grant minted against the personal
org.

## Decision

- Consent stamps `orgId` on the grant in **both** `props` and `metadata`. A
  grant without a stamped `orgId` fails closed; the earlier
  `props.orgId ?? props.userId` fallback was removed once no live grant lacked
  the stamp (#3903).
- Clients may pass `?org=<slug>` on the authorize URL and/or the `/mcp`
  resource. A mismatch is an authorize error. The consent screen is **live, no
  feature flag**: one accessible org is auto-selected and the picker is hidden;
  several orgs require an explicit choice (public field is the slug, never the
  org id).
- Connection profiles stay org-bound resource narrowing (Cole §15.7). They are
  not folded into OAuth scopes.
- OIDC ID tokens and UserInfo identify the person and their selected org in
  `sub`, so clients can connect several orgs for the same person. Personal orgs
  keep the existing user-id subject. Other orgs use
  `org:<encoded org id>:user:<encoded user id>`, with each id encoded using
  `encodeURIComponent`. Refresh keeps the same subject.

## Consequences

`/mcp` and the CLI OAuth Open API path read `orgId` from grant props and load
that org (`loadOrgBindingForOrg`), not always the person's personal org. Public
surfaces keep showing `@slug`. Grants without `orgId` fail closed.
