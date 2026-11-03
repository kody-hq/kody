# 0096: An execution context records its box login and warns grantees about excess access

- **Status:** accepted
- **Date:** 2026-11-03
- **Amends:** [0092](./0092-profiles-are-scoped-agent-identities.md) (a
  person-owned agent profile may name the team it is for; the name confers
  nothing)

## Context

A shared execution context (a "box") is logged in as someone: a person, or one
of their agent profiles. Runs on the box sign with the context key and act as
the requester, so Kody API calls never use the box login. Host commands and host
folders do: they run as the daemon's OS user with whatever that login can reach.
Kent wants the box login compared with the access of everyone who can run there,
and a warning when the box can do more than they can.

## Decision

Kent decided on 2026-11-03:

1. **The box login is recorded on the context.** Registration stores
   `login_kind` (`person` or `profile`), the acting person, the profile, and the
   token id. Kody API calls stay limited to the requester's own access; the box
   login is not a cap and grants nothing.
2. **Team assignment is metadata.** `profiles.assigned_team_id` names the team a
   person-owned profile is for, and `execution_contexts.team_id` the team a box
   is for. Neither grants access; they drive misconfiguration flags.
3. **Excess access is a notice, not a gate.** For each grantee Kody computes the
   box login's access minus the grantee's own (per permission and resource; an
   Owner login is one `owner` entry). There is no acknowledgment: accepting the
   share is the consent. A notice fires only when excess is new, gains an entry,
   or the box login changes; a removal never re-raises it.
4. **Only people who can act see it.** The grantee sees their own; the operator
   and Manage holders see every grantee in the access review and before saving a
   share; the operator sees misconfigurations.
5. **Only the subject dismisses, signed in as themselves.** Dismissal holds
   until the fingerprint changes; it never expires. Misconfigurations
   (`operator_left`, `login_stale`, `profile_inactive`, `team_deleted`,
   `personal_login_on_team_context`, `profile_not_assigned_to_team`) cannot be
   dismissed.
6. **Surfaces.** The context page, the share form, "what's waiting on me"
   (`context-elevation`, `context-misconfigured`), and a declared `notices`
   field on execute (context-routed runs) and search results, each carrying a
   given fingerprint once.
7. **No agent-profile requirement.** Personal-login boxes keep working with no
   warning for the login alone. Docs recommend an agent profile assigned to a
   team.

## Consequences

- Grantee lists past 200 people are not tracked eagerly; their notices appear
  when they run on the box.
- Login changes after registration are recorded on the next registration; the
  signed rebind and operator transfer route is follow-up work.
