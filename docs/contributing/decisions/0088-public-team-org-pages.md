# 0088: Team orgs have a public page at `/@slug`

- **Status:** accepted
- **Date:** 2026-10-29

## Context

`orgs.profile_visibility` (`public` | `private`, default `public`) came over
with the profile columns in [0063](./0063-teams-expand-orgs.md), and team-org
create already wrote `public`, but only the org avatar route read it. `/@slug`
looked up `users` only, so a team org was a 404 for everyone who was not a
member, and nothing could change the setting. Package pages hid the owner link
for team orgs for the same reason.

## Decision

Follow GitHub: a team org has a public page, chosen at creation and changeable
later.

- **Default public.** Create (web form, `orgCreate`) takes `profile_visibility`
  and defaults to `public`. Existing rows keep their stored value; there is no
  backfill. Owners (`org:write`) change it in org Settings or with `orgUpdate`.
  Each change writes `org.profile_visibility_changed` (new and previous value)
  to `org_audit_events`; `org.created` records the initial value.
- **What a public page shows.** Avatar, display name, bio, created date, and the
  org's public, non-hidden packages from the public-only listing query, so
  private names never leave the server. Never members, teams, activity, or
  billing. The page is the same for every viewer.
- **Members.** On a public org, members see the public page with a link to the
  org home (`/@slug?view=home`); the home links back to the public page. On a
  private org, members get the home at `/@slug` as before. "Members" here means
  anyone the org switcher lists, including grant-only collaborators, who get the
  collaborator home (links only, no data), unchanged from before.
- **No existence leak.** A private org, an unknown handle, a soft-deleted org,
  and a suspended org return the same 404 to anyone who is not a member.
- **Personal orgs are unchanged.** The signup org's page is the person's profile
  and follows `users.profile_visibility`; org visibility writes refuse it.
- **Owner links.** Package pages link the owner when `users.profile_visibility`
  is public, or, for a team org (no `users` row), when `orgs.profile_visibility`
  is public.

## Consequences

- An org's activity is per person today
  ([#3331](https://github.com/kody-hq/kody/issues/3331)), so the public page has
  no activity column.
- Viewer-specific responses (members) are `no-store`; the signed-out page has no
  member-only data.
