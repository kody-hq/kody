# Profiles

A profile is a scoped identity in one org for an agent or bot you run. It holds
only the access you hand it, can expire, and can have sub-profiles for the
agents it starts. Usage and behavior live in the
[Profiles guide](../guides/profiles.md)
(`search({ entity: "guide:profiles" })`).

Profiles are an experiment. Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "profiles", enabled: true })`.

## Fields

- `profileCreate` takes `name` (lowercase letters, digits, dashes; unique among
  your profiles under the same parent), optional `parent_profile_id` for a
  sub-profile, optional `expires_at` (ISO 8601), and optional `grants[]`:
  `{ resource_type, resource_id, permissions[] }`.
  - `resource_type` is one of `package`, `app`, `job`, `credential`, `memory`,
    `email`, `execution_context`, or `org`. An `org` grant (with `resource_id`
    set to the org id) carries only org-level permissions: `org:read`,
    `org:execute`, `search:read`, `member:read`, `team:read`, `audit:read`, and
    `<type>:create`. A profile never gets access to a whole kind of resource at
    once, such as every package.
  - Every permission must be one you hold on that resource now. For a
    sub-profile it must also be one every parent profile holds.
- `profileList` returns your profiles; Owners can pass `all_members: true`.
  `profileGet` takes `profile_id`.
- Each profile has `status`: `active`, `expired`, `revoked`, or
  `parent_inactive` (a parent above it is revoked or expired). `chain` lists the
  parents root first, and `effectiveExpiresAt` is the earliest expiry across the
  chain.
- `profileUpdate` takes `profile_id` and `expires_at`. Expiry only moves
  earlier; a later time is refused with `profile_expiry_extension`.
- `profileRevoke` takes `profile_id`. Revoke is final and stops every
  sub-profile below it.

## Limits

- Sub-profiles nest at most 5 levels deep (`profile_depth_exceeded`).
- At most 100 live profiles per person per org (`profile_limit_reached`) and 50
  grants per profile.
- Grants are a snapshot: a profile never gains access later when you or a parent
  do.
- Revoked and expired profiles are deleted 30 days later.
- When you leave an org, your profiles in it are revoked.

## Who can change a profile

- You control the profiles you create.
- A profile can manage only the sub-profiles below it, never itself, its
  parents, or its siblings.
- An org Owner can list and revoke any profile in the org but cannot change one.

## Package grants

Share a package from its **Collaborators** tab (**Add one of your profiles**) or
with `packageCollaboratorSet({ package_id, profile_id, preset })`. A sub-profile
only gets what its parent holds on that package. Profile grants list with
`kind: "profile"`.

## Running profile

`whoami` returns `profile: { id, name, ancestors } | null`. It is informational;
grants enforce access.

## Grant expiry

Grants to people, teams, and the org can expire too: pass `expires_at` to
`accessGrant`. A new grant without `expires_at` never expires; rewriting a grant
without it keeps its current expiry, and `null` makes it unlimited. See
[organizations](../guides/organizations.md).
