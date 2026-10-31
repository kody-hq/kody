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
acting as you. You decide what it can reach when you create it, and it never
gets more later.

Profiles are an experiment. Turn them on at `/account/experiments` or with
`experimentSet({ experiment: "profiles", enabled: true })`. In this release you
can create, list, shorten, and revoke profiles; signing an agent in as a
profile comes in a later release.

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

- Each grant names one resource. A profile cannot get an org-wide grant.
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
- stops working when any parent is revoked or expires (`status:
  "parent_inactive"`).

Profiles nest at most 5 levels deep.

## Shorten or revoke

- `profileUpdate({ profile_id, expires_at })` moves expiry earlier. It never
  moves later; create a new profile for more time.
- `profileRevoke({ profile_id })` ends a profile and everything below it. It
  cannot be undone.

Only you (or a profile above it) can change your profile. A profile cannot
change itself, its parents, or its siblings. An org Owner can list every
profile (`profileList({ all_members: true })`) and revoke any of them, but
cannot change one.

## Lifecycle

- Leaving an org revokes your profiles in it.
- Revoked and expired profiles are deleted 30 days later.
- `profileList` shows each profile's `status`, `chain`, and
  `effectiveExpiresAt`.

Field reference: [docs/use/profiles](../use/profiles.md).
