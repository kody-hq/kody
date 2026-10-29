# 0084: Org feature flag rows target the request org

- **Status:** accepted
- **Date:** 2026-10-28

## Context

[Feature flags](../architecture/feature-flags.md) had a global row (enabled,
rollout percent, audience), per-user overrides, and per-repo rows. Turning a
flag on for a whole team meant one user override per member, and new members
were missed. A user can belong to several orgs, so a per-org row needs a rule
for which org counts.

## Decision

Kody adds `feature_flag_org_overrides` rows keyed by stable `orgs.id`, each with
`enabled`, `note`, `updated_by`, and `updated_at`. Precedence, highest first:

1. Repo row (repo-scoped flags only).
2. Per-user override, on or off.
3. Org row for the org context, on or off.
4. Global row (rollout percent and audience).
5. Registry default.

The org context is the org of the request or run: the request org binding for
MCP, `execute`, and the Open API (the org that owns the package or resource
being used, defaulting to the caller's personal org), the `/@slug` org of the
page for the website, and the owning org for repo, credential, and custom domain
checks. A user in several orgs is evaluated only against that one org, never
against all their memberships. With no org context (anonymous requests, pages
outside an org path, user-only gates) org rows do not apply. An org row applies
only to live members of an active org (or the personal org's owner).

Org rows bypass the audience gate like user overrides, and exposures record
source `org`, which the metric readout keeps out of the fair on/off cohorts as
its own `orgOverride` cohort. Existing user overrides are unchanged.

## Consequences

One audited row enables a team, and user overrides still carve out exceptions
either way. The same person can see a flag on in one org and off in another, so
every cache of evaluated flags is keyed by user and org. Gates that only know
the user (connection profiles, MCP event fan-out) ignore org rows until they
carry an org context.
