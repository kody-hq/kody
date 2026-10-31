# Profiles

A profile is a scoped identity in one org for an agent or bot you run. It holds
only the access you hand it, can expire, and can have sub-profiles for the
agents it starts. Usage and behavior live in the
[Profiles guide](../guides/profiles.md)
(`search({ entity: "guide:profiles" })`).

Profiles are an experiment. Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "profiles", enabled: true })`.

Manage them in the browser at
[`/account/profiles`](https://kody.codes/account/profiles) (your personal
workspace) or `/@{org}/-/profiles` for a team org: a tree of your profiles and
their sub-profiles, with status, expiry, grants, and profile tokens. Owners add
`?members=all` to see and revoke every member's profiles.

## Fields

- `profileCreate` takes `name` (lowercase letters, digits, dashes; unique among
  your profiles under the same parent), optional `parent_profile_id` for a
  sub-profile, optional `expires_at` (ISO 8601), and optional `grants[]`:
  `{ resource_type, resource_id, permissions[] }`.
  - `resource_type` is one of `package`, `app`, `job`, `credential`, `memory`,
    `email`, `execution_context`, or `org`. An `org` grant (with `resource_id`
    set to the org id) carries only org-level permissions: `org:read`,
    `org:execute`, `search:read`, `member:read`, `team:read`, `audit:read`,
    `profile:manage` (so the profile can create its own sub-profiles), and
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

## Profile tokens

- `tokenCreate` (Open API `POST /v1/tokens`, through the MCP `api` tool or the
  CLI) takes optional `profile_id` to mint a token that acts as that profile. A
  token already bound to a profile defaults to its own profile and can only name
  itself or a sub-profile below it.
- A profile token expires no later than the earliest `expires_at` in the profile
  chain. Profile tokens have their own limit and never push out your person
  tokens.
- `/mcp` (and its `api` tool) does not take profile tokens. Use them with the
  Open API or the CLI (`KODY_API_TOKEN`).
- `cliCredentialBootstrap` refuses a profile-bound caller. Mint with
  `tokenCreate({ profile_id })` or `profileHandoff` instead.

## Hand off to a sub-agent

`profileHandoff` (`POST /v1/profiles/handoff`) creates a profile and mints a
token bound to it in one step. It takes `name`, optional `parent_profile_id`,
optional `expires_at`, `grants[]` (same shape as `profileCreate`), `scopes`,
optional `lifetime` (`short` by default), and optional `token_name`. It returns
`{ profile, token }`. Called with a profile token, the new profile is a
sub-profile of the calling profile unless `parent_profile_id` names one below
it. Called as yourself without `parent_profile_id`, it creates a top-level
profile. If minting fails, Kody tries to revoke the new profile; if that also
fails, revoke it yourself with `profileRevoke`.

## What a profile can use

- **Credentials:** only ones granted to the profile chain (`<family>:use` on
  that credential). Package Keys follow `package:execute` on their package.
- **Memory:** none unless a grant includes it.
- **Execution contexts:** a run routes to a context only when the profile chain
  holds `execution_context:execute` on it; otherwise the context is skipped with
  reason `profile_grant`. Host commands (`kody.command.*`) on a context also
  need `execution_context:command` in every layer of the chain, even when you
  operate the machine.
- **Jobs, triggers, app visits:** what a profile turns on runs as that profile.
  When the profile or a parent is revoked or expires, the enablement pauses with
  `paused_reason: "profile_inactive"`. It stays paused until an active
  credential turns it on again, which checks the chain afresh.
- **Event subscriptions and follows:** delivery checks the subscribing or
  following profile's access, not yours.

## Attribution

Runs record the profile id and its chain (ids, root first) as they were when the
run started, so attribution survives the profile being purged.
