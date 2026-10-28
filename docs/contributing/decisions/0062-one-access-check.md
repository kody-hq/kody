# 0062 — One org access check, declared by every surface

- **Status:** accepted
- **Date:** 2026-10-09
- **Amended:** 2026-10-09 (Teams P4: tokens carry org permissions;
  `x-kody-scope` check removed)

## Context

With one request context per request
([ADR 0061](./0061-one-request-context.md)), org access still had no single
place to be decided. Connection profiles, token scopes, and owner checks each
ran their own logic, and nothing recorded what a capability or Open API
operation needs. Site-admin RBAC (`requiredRole`, `*:any`) is a different system
for Kody staff and must not blur into org access.

## Decision

- `authorize({ env, request }, permission, resource?)`
  (`packages/worker/src/authorization/authorize.ts`) is the one org access
  check. It runs signed in, org binding, effective permissions, credential
  scopes, and connection-profile narrowing, in that order, and throws
  `AuthorizationError` naming the permission, org, and resource.
- `computeEffectivePermissions` compiles role presets (Owner: all; Member and
  Billing: org-level basics) and is cached per request context. Automation acts
  for the org that owns the job, webhook, or subscription.
- Every capability declares a required `orgPermission: OrgPermission | 'none'`.
  `defineCapability` checks it at dispatch with `authorizeSurface`. Open API
  operations publish it as `x-kody-permission`; native operations declare it in
  `nativeRoute`.
- `none` means the surface touches no org data. Site-admin capabilities declare
  `none`; a test fails if one declares an org permission.
- Site-admin checks stay separate and run first.
- Connection-profile narrowing lives only in `authorize`. Lists, search, skills,
  MCP events, and package import resolution compile once with
  `computeEffectivePermissions` and decide with `checkPermission` or
  `canSeeResource`. The profile is read from `request.credential.profileName`,
  which Automation and inherited runs keep.

We do **not**:

- change behavior: every person is the Owner of their implicit org, so only
  connection profiles and missing sign-in can deny
- filter discovery by org permission

**Amended (Teams P4, 2026-10-09):** API tokens carry org permissions.
`authorize` step 4 (credential scopes) is the only token narrowing check. P4
removed the legacy `x-kody-scope` Open API field and the write-implies-read
hierarchy. Operations publish `x-kody-permission` only.

**Amended (org-wide reads, 2026-10-28):** organization grants may carry
read-only resource permissions (`package:read`, `app:read`, `job:read`,
`integration:read`, `email:read`), so a Member can read across the org without
Owner. No write, execute, use, or `manage_access` permission is grantable on the
org. See [Authorization](../architecture/authorization.md#org-access).

## Consequences

A capability without a permission does not compile. Handlers that touch a
concrete resource call `authorize` with it, so later org grants narrow them
without new checks. See
[Authorization](../architecture/authorization.md#org-access).
