---
id: organizations
title: Organizations
summary:
  Personal vs team orgs, invite links, who automation runs as, the org-wide
  execute pool, connecting one client to several orgs, free-org limits, and paid
  seats.
category: platform
audience: agents
---

# Organizations

Every signed-in person has a **personal** (signup) organization. You can also
create **team** organizations. Resources (packages, secrets, jobs, and so on)
belong to one org. Handles are permanent: `@slug` does not rename.

The org is the billing and data boundary: its resources, usage, limits, and bill
stay inside it. Inside an org, grants control access. Owners hold everything,
Members hold the org basics (`org:read`, `member:read`, `team:read`,
`search:read`) plus what they are granted, and an outside collaborator holds
catalog search (`search:read`) plus their grants. See
[Share a package](/docs/package-sharing) for presets and grants.

### Org-wide read access

To let a Member read everything of one kind without making them an Owner, an
Owner grants read access on the organization: **Grants** page,
**Organization-wide read access**, or `accessGrant` with `resource_type: "org"`:

```json
{
	"resource_type": "org",
	"resource_id": "<org id>",
	"subject_type": "user",
	"username": "casey",
	"permissions": ["job:read"]
}
```

From the CLI: `kody api accessGrant --org <slug> --params '<that JSON>'`.

| Permission         | Reads                                                     |
| ------------------ | --------------------------------------------------------- |
| `job:read`         | Every job, workflow, and run (`runList`, `runGet`, ...)   |
| `app:read`         | Every package app and its sessions                        |
| `package:read`     | Source, skills, and checks for every package and repo     |
| `integration:read` | Which integrations and MCP servers exist, never a token   |
| `email:read`       | Every inbox and message, including sign-in codes they get |

These are read only. Running, editing, triaging runs, sharing, and using a
credential still need their own grant. Secret values and memories are never
grantable org-wide.

## Personal vs team

|                    | Personal                                             | Team                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created            | At signup (slug = username)                          | `orgCreate` or Create organization                                                                                                                                                              |
| Members / teams    | No. Create a team org to invite people or group them | Yes                                                                                                                                                                                             |
| Package grants     | `accessGrant` / grant invites / package invite links | Same, plus the Grants web page                                                                                                                                                                  |
| Resource web pages | Secrets, jobs, repositories, agents, and the rest    | Every resource page reads the org. Agents lists connections approved for that org; **Repositories** lists packages you can see plus every plain repo the org owns (API/CLI still say `package`) |

Switch orgs from the workspace name at the top of the workspace rail (it keeps
the section you are on), from the avatar menu's Manage group, or pick the org at
MCP consent. Overview is `/@<slug>/-/overview` on a personal org and `/@<slug>`
on a team org. One connection binds one org.

## Invites

An invite waits on the person it is for and shows on the page that sent it:

- **Waiting on you.** Every pending invite you can answer is a card on your
  Waiting page (`/@<org>/-/waiting`) and a row in the Invites panel on your
  Organizations page (`/account/organizations`), each with **Accept** and
  **Decline**. That covers invites addressed to your email or username and
  invite links you opened. An invite sent to your email needs a verified email
  before you can answer it on the web. Declining ends the invite (recorded as
  `invite.declined`).
- **Sent by you.** The page you sent it from lists it until it is answered or
  lapses: **Members** shows invites addressed to people as Pending, with
  **Revoke** on membership invites, plus active Members links; **Teams** lists
  each team's links; a package's **Collaborators** tab lists its links. Every
  link has **Revoke**.

Agents use `inviteAccept` with the token and `inviteRevoke` for addressed
invites.

## How do I invite my whole team?

Use a **Members** invite link when you do not know every email yet, or when many
people should join with the same role. Prefer addressed `inviteCreate` only when
you need to invite one known person (and optionally Owner).

1. On the web: open `/@<org>/-/members`, create an invite link (Member by
   default; optional label, default teams, domains, max uses, expiry), copy the
   credential once, and share it.
2. As an agent: call `inviteLinkCreate` (needs `member:write`) in that org, then
   share the returned URL or tell people to call `inviteLinkAccept` with the
   token. List with `inviteLinkList`. End a link with `inviteLinkRevoke`.
3. CLI/Open API: `POST /v1/access/invite-links`, `GET /v1/access/invite-links`,
   `POST /v1/access/invite-links/accept`, and
   `POST /v1/access/invite-links/{invite_link_id}/revoke`.

## Invite links

An invite link lets someone in without knowing their email or username. You make
one where you would otherwise add the person, and what it gives depends on where
you made it:

| Made on                           | Accepting it                                                                               | Who can make it                 |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| **Members** (team org)            | Joins the org as Member or Billing; optional default teams                                 | `member:write`                  |
| **Teams**, one team (team org)    | Joins that team, and the org as Member if they are not in it yet                           | `team:write` and `member:write` |
| A package's **Collaborators** tab | Grants the chosen preset on that package; non-members stay outside collaborators (any org) | Manage on the package           |

Opening a link signs the person in or lets them create an account (every signup
method asks them to choose their own username first), then shows an accept page
with what the link gives and who sent it. Nothing happens until they choose
**Accept**; they can also **Decline**. A signed-in person who opened a link sees
it on their Waiting page and in the Invites panel on their Organizations page
until they accept or decline it, or it stops working. OAuth keeps the join URL
through redirects via `redirectTo`.

Links last 7 days by default (up to 365; every link expires) and can be limited
by number of uses. Members links can also carry an optional label, default
teams, and a verified email domain allowlist. The link is a credential: Kody
stores only a hash, so the full URL is shown once. Each page lists its active
links with uses and expiry; the Members page also shows last used. **Revoke**
ends one right away. A link also stops working when its org is no longer active,
when the team or package it points at is deleted, or when the person who made it
loses access. Someone removed from the org can rejoin with the same membership
link while it is live (idempotent for people who are already members). Team and
package links are spent per person, so removing someone is not undone by the
link they already used.

Agents use `inviteLinkCreate`, `inviteLinkList`, `inviteLinkRevoke`, and
`inviteLinkAccept` (same surfaces as Open API and the CLI). Creating, revoking,
and accepting are recorded in the org audit log as `invite_link.created`,
`invite_link.revoked`, and `invite_link.joined`, with the link's kind, team or
package, label, teams, and preset in the details.

## Automation runs as the person who turned it on

A scheduled job, subscription, or webhook runs only after a person turns it on
for themselves, by approving it on the package's approval page (or, for a job or
subscription, with `enablementEnable`). Turning a cron enablement on also turns
that job's `enabled` flag on and schedules the next tick when the enabler holds
`job:write`. Without `job:write` the enablement still turns on but leaves the
job unchanged: a job that was off stays off, and the enablement result's `job`
field says so (`state: "left_off"`, `missing_permission: "job:write"`); a job
that was already on stays on (`state: "already_on"`). Minting a webhook URL does
not turn it on: the mint returns the approval link, and deliveries fail with
that link until someone approves. A webhook URL runs as one enabler. That person
is the **enabler**, and every run acts as them:

- The run has the enabler's live access in the org, checked on every run. It can
  do only what the enabler could do by hand at that moment, never more.
- Credentials resolve only when the enabler holds Use on them.
- If the enabler loses access (leaves the org, loses `package:execute`, or loses
  Use on a credential the run needs), the enablement pauses and its events are
  dropped. It resumes by itself once access is back. A run never falls back to
  another person or to Owner.
- A paused enablement shows on its enabler's own Waiting page for that org, with
  what the run needed. Other members and Owners do not get that card.
- Usage counts against the org that owns the trigger, and the run is audited to
  the enabler.

Some actions need a live person, even when the enabler is an Owner. No job,
webhook, subscription, or inbound email handler can do them, and neither can
package code one of those started or a package app's server code:

- Role and membership changes: adding or removing members, changing a role,
  invites, and grants that carry member or billing permissions.
- Billing changes: plan, seats, payment, wallet, budgets, and promo codes.

Do these from the web app, an MCP or CLI call you make yourself, or an execute
you run. A triggered run that tries one fails with
`Capability "<name>" needs a live person`, naming the capability it tried.
Everything else runs unattended with the enabler's live permissions.

Site-admin tools run unattended too when the person the run acts for is a site
admin: a job, webhook, subscription, inbound email handler, or `jobRunNow` in
that person's personal org or any team org they enabled (or clicked run-now in)
may call them, and every such call is audited with its trigger type and id.

Publishing a package never turns anything on, and nobody can enable a trigger
for someone else. `enablementList` shows your enablements (an Owner can list the
whole org's). `enablementDisable` turns one off; its enabler or an Owner may do
that.

Every time a job or an enablement turns on or off, the org audit log records who
did it (a person, an automation run, or a site admin), when, the old and new
state, where it came from (web app, MCP, API, CLI, the scheduler, and so on),
and the reason when one was given (`jobUpdate` and `enablementDisable` take an
optional `reason`). Owners see the last 7 days under **On/off changes** on the
Activity page. A job that reaches its own expiry time turns off without a row,
and pause and resume are a separate state with their own reason.

Example: Bea is a Member of `@acme` with Use on `@acme/digest`. She turns on its
nightly job. Each night it runs as Bea, with Bea's grants. It cannot read a
secret Bea has no Use on, and it cannot change roles even if Bea becomes an
Owner. If an Owner removes Bea from `@acme`, the job pauses until someone else
turns it on for themselves.

## Execute limits: one org-wide pool

Hosted execute limits (unique execute workers per day and per week) are one pool
per org, not per person:

- **Free**: one pool for the whole org (see the table below).
- **Pro**: the pool is the per-seat include times paid seats, so it grows with
  every Owner and Member. Funded credits carry it further, up to a ceiling that
  also scales with seats.
- The runaway brake (execute calls started per minute) is also per org: 300 for
  each Owner and Member, at least 300, on every plan.

A connection draws from the pool of the org it is bound to:

- A **Member** connected to `@acme` draws from acme's pool and is one of acme's
  seats.
- A **grant-only collaborator** connected to the owning org draws from that
  org's pool too, but is not a seat and does not grow the pool.
- Work in a person's personal org draws from that personal org's own pool.

Example: Jesse holds Use on `@acme/bot` and is not a member. Connected as
`@acme`, his runs count against acme's execute pool, credits, and budgets.
Nothing is charged to Jesse's personal plan, and acme's seat count does not
change.

## Connect one client to two orgs

A connection binds exactly one org at consent
([ADR 0064](https://raw.githubusercontent.com/kody-hq/kody/main/docs/contributing/decisions/0064-oauth-org-binding.md)).
To use two orgs from the same client, add Kody twice, once per org, with
`?org=<slug>` on the MCP URL:

```text
https://kody.codes/mcp?org=ada
https://kody.codes/mcp?org=ada-work
```

Each entry runs its own consent with that org selected, gets its own grant, and
acts only in that org. The slug must be an org you can access, and a slug that
disagrees with the one picked at consent is refused. Without `?org=`, consent
picks your only org or asks you to choose. For the CLI, use
`kody login --org <slug>`.

## Free team org limits

A new team org starts on the **same Free plan** as a personal org
([/pricing](/pricing)). There is no separate free-team SKU.

| Limit                                   | Free                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Free orgs you **own** (personal counts) | **2**, so one free team org beside personal                                               |
| Seats                                   | No seat charge on Free. Paid Pro seats are Owners + Members only ($12/seat/mo or $120/yr) |
| Saved packages                          | 10                                                                                        |
| Repos                                   | 20                                                                                        |
| Scheduled jobs                          | 5 (fastest interval 15 minutes)                                                           |
| Execute (unique workers) / day · week   | 150 · 400                                                                                 |
| Outbound fetches / day · week           | 1,000 · 2,500                                                                             |
| Job runs / day                          | 500                                                                                       |
| Automation invocations / day            | 1,000                                                                                     |
| Secrets                                 | 25                                                                                        |
| Storage                                 | 16 MiB                                                                                    |
| Concurrent workflows                    | 1                                                                                         |
| Active repo sessions                    | 5                                                                                         |

Credits: Free has no prepaid debit wallet. New accounts get a $5 welcome grant
held until the account is **credit-eligible Pro** (purchasable Pro subscription,
or admin credit eligibility on an effective Pro plan; not every paid price is
eligible). Until then the balance is held and not spent.

Example: Ada owns `@ada` (personal, Free) and creates `@ada-work` (team, Free).
That uses both free-org slots. A third free org she tries to own is refused
until one is paid or deleted.

## Paid seats

When an org is Pro, each live Owner and Member is a seat, and each seat grows
the org's execute pool. Billing-only members and outside collaborators are not
seats. See [Share a package](/docs/package-sharing) for grants vs membership.
