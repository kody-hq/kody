---
id: profiles
title: Profiles
summary:
  Give an agent or bot its own scoped identity in an org, with a snapshot of
  your access, an expiry that only shortens, and sub-profiles for the agents it
  starts. An experiment you turn on at /account/experiments.
category: platform
audience: agents
---

# Profiles

A profile is an identity in one org that an agent or bot acts as instead of
acting as you. You decide its starting access when you create it. It gets more
only when someone explicitly grants it something, such as sharing a package with
it, or when it creates something and gets the creator grant on it. It never
holds more than you and its parents hold.

Profiles are an experiment. Turn them on at `/account/experiments` or with
`experimentSet({ experiment: "profiles", enabled: true })`. In this release you
can create, list, shorten, and revoke profiles, and share packages with them;
handoff tokens that sign an agent in as a profile come in the next release.

## How access is checked

A request running as a profile reaches something only when all of these allow
it: your own live access, the profile's grants, every parent profile's grants,
and the credential's scopes. Being an org Owner does not skip a profile's
limits. A denial names the layer that blocked it:

- `profile_grant`:
  `Profile "helper" was not granted package:execute on package @acme/tools` (or
  `Parent profile "agent" does not hold ...`).
- `profile_inactive`: the profile or a parent was revoked or expired.

## Share a package with a profile

Open the package's **Collaborators** tab and use **Add one of your profiles**,
or call:

```ts
packageCollaboratorSet({
	package_id: 'pkg_...',
	profile_id: 'prf_...',
	preset: 'use',
})
```

A sub-profile can only get what its parent already holds on that package, and it
still never gets more than you. `packageCollaboratorList` shows profile grants
with `kind: "profile"`; `packageCollaboratorRemove` takes their `grant_id`.

## Which profile is running

`whoami` (and `meta_get_current_user`) returns
`profile: { id, name, ancestors }` when the request runs as a profile, ancestors
root first, or `null` when it runs as you. Use it to branch behavior, never as a
security check: grants enforce access.

## What a profile creates

When a request running as a profile creates a package, app, or credential, both
the profile and you get `manage` on it, so nothing is stranded when the profile
ends. Publishing under a profile is refused when the profile chain cannot run a
package the new version imports.

## Create a profile

Call `profileCreate` with a name and the grants it starts with:

```json
{
	"name": "release-bot",
	"expires_at": "2026-12-31T00:00:00Z",
	"grants": [
		{
			"resource_type": "package",
			"resource_id": "<package id>",
			"permissions": ["package:read", "package:execute"]
		}
	]
}
```

- Each grant names one resource, or the org itself for org-level permissions
  only: `org:read`, `org:execute`, `search:read`, `member:read`, `team:read`,
  `audit:read`, `profile:manage`, and any `<type>:create`. A grant that covers
  every resource of a kind is refused.
- You can only hand over permissions you hold on that resource right now.
- Grants are a snapshot. When you or a parent later gain access, the profile
  does not.

## Sub-profiles

Pass `parent_profile_id` to create a sub-profile, for an agent your agent
starts. A sub-profile:

- gets only permissions every parent holds (`profile_grant_exceeds_parent`
  otherwise);
- never outlives its parents: without `expires_at` it inherits the earliest
  parent expiry, and a later one is refused;
- stops working when any parent is revoked or expires
  (`status: "parent_inactive"`).

Profiles nest at most 5 levels deep.

## Shorten or revoke

- `profileUpdate({ profile_id, expires_at })` moves expiry earlier. It never
  moves later; create a new profile for more time.
- `profileRevoke({ profile_id })` ends a profile and everything below it. It
  cannot be undone.

Only you (or a profile above it) can change your profile. A profile cannot
change itself, its parents, or its siblings. An org Owner can list every profile
(`profileList({ all_members: true })`) and revoke any of them, but cannot change
one.

## Lifecycle

- Leaving an org revokes your profiles in it.
- Revoked and expired profiles are deleted 30 days later.
- `profileList` shows each profile's `status`, `chain`, and
  `effectiveExpiresAt`.

Field reference: [docs/use/profiles](../use/profiles.md).
