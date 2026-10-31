# 0092: Profiles are scoped agent identities, capped by their parent chain

- **Status:** accepted
- **Date:** 2026-10-30

## Context

A person who hands Kody to an agent or bot today hands over everything they can
reach. Credential scopes narrow permissions, not resources, and the old
connection profiles never shipped past a flag. People need an identity for an
agent that holds only what they hand it, can expire, and can start its own
sub-agents with even less.

## Decision

Kent decided on 2026-10-29 (Bot identities plan, decisions 1 to 23):

1. **A profile is a person-owned identity in one org.** `profiles` rows carry
   the acting person, an optional parent, a depth (1 to 5), an optional expiry,
   and a terminal `revoked_at`. Org-owned bot profiles are deferred.
2. **Snapshot grants.** A profile's access is `grants` rows with
   `subject_type = 'profile'`. At creation every grant must be a subset of what
   the creator holds and, for a sub-profile, of its parent's grants. Expiry only
   shortens. At most 50 grants per profile and 100 active profiles per person
   per org.
3. **Live mirror at run time.** A profile-bound request intersects the acting
   person's live access, every profile layer from the tip to the root, and the
   credential's scopes. Owner status never bypasses a profile layer. A revoked
   or expired profile or ancestor fails closed (`profile_inactive`); a missing
   grant on a layer denies with `profile_grant`, naming the layer.
4. **Concrete resources only.** Profiles hold grants on concrete resources.
   Org-level grants are limited to `org:read`, `org:execute`, `search:read`,
   `member:read`, `team:read`, `audit:read`, and `*:create`; no
   resource-family-wide access.
5. **No access-epoch bump.** Profile rows and profile grants never change a
   person's access or the org binding, so their writers do not bump
   `orgs.access_epoch`. The chain is one recursive CTE, loaded only for
   profile-bound requests.
6. **Teams stay flat.** A profile is never a team member; teams grant people.
7. **Packages grant profiles like collaborators.** The Collaborators tab and
   `packageCollaboratorSet` (`profile_id`) write a profile grant capped by every
   parent's grant on the package.
8. **Creators.** A profile that creates a resource gets `manage` on it
   (`origin = 'created'`), and so does the acting person, so nothing is stranded
   when the profile ends. An org transfer drops profile grants; offboarding
   revokes the member's profiles.
9. **Publishing never confers access.** A publish under a profile is refused
   when the chain cannot run a package the new version imports, naming the
   import and the blocking layer.
10. **Running profile is informational.** `whoami` (and the package runtime
    context) report the profile and its ancestors; grants alone enforce access.
11. **Purge.** Revoked or expired profiles are purged after 30 days.

Everything is behind the `profiles` feature flag (Experiments opt-in). Direct
profile tokens on `/mcp` and `asProfile` are out of scope;
[0053](./0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md) is unchanged.

## Consequences

- Every authorization check already goes through `checkPermission`, so profile
  narrowing reaches packages, apps, jobs, memory, credentials, and execution
  contexts without per-surface code.
- Unprofiled requests pay no extra query.
- Handoff tokens, credential and execution-context routing for profiles, and
  enablement attribution land in the next profiles phase.
- The old connection profiles (named, package-only narrowing behind the
  `connection-profiles` flag) are removed. OAuth grants and API tokens still
  stamped with a connection profile name are refused, not widened, so the holder
  signs in again. The legacy name columns are dropped in a separate migration
  after the code that reads them is gone, because Deploy applies D1 migrations
  before the new Worker version goes live. The `connection_profiles` table goes
  one deploy later still, because account deletion and org soft-delete listed it
  until the column drop shipped.
