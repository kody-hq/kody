---
id: package_sharing
title: Share a package and manage access
summary:
  Give a person or team Use, Contribute, or Manage on one package with a grant,
  invite someone who is not in your organization yet, and know what each side
  can run, read, and pay for. Fork instead when they should own a copy.
category: platform
audience: agents
---

# Share a package and manage access

Access in Kody belongs to an **organization**. Resources (packages, apps, jobs,
secrets, integrations, memory, email) live in one org, and a **grant** gives one
person or team a preset on one resource. To let someone use a package without
sharing a login, grant them **Use** on it.

> [!TIP] Prefer a
> [fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating)
> when they should own and edit a copy. Grant access when they should run
> **your** live package.

## Presets

| Preset         | On a package                                                        |
| -------------- | ------------------------------------------------------------------- |
| **Use**        | Read the source and run it (`package:read`, `package:execute`)      |
| **Contribute** | Use, plus write (`package:write`)                                   |
| **Manage**     | Contribute, plus publish, delete, and manage access for the package |

Advanced grants take an explicit permission list instead of a preset. No preset
includes `billing:*` or revealing a secret.

## Grant access

Call `accessGrant` from a request bound to the org that owns the package. You
need manage access on the package.

```json
{
	"resource_type": "package",
	"resource_id": "<package id>",
	"subject_type": "user",
	"username": "jesse",
	"preset": "use"
}
```

`accessList` shows who holds what across the org. `accessRevoke` removes one
grant by `grant_id`. To change someone's preset, call `accessGrant` again for
the same subject; it updates the grant.

## Package collaborators

For one package, three calls cover teams and members of the owning org. Each
needs Manage on the package, and `package_id` takes the package id or its kody
id.

- `packageCollaboratorList` (`{ "package_id": "…" }`) lists everyone who holds a
  grant on the package: teams, members, and outside collaborators, each with
  `grant_id`, `kind`, username or team slug, and preset.
- `packageCollaboratorSet` adds a team or org member, or changes the preset of
  one already listed. Pass exactly one of `team_slug`, `team_id`, `username`, or
  `user_id`. People outside the org are refused, and Owners already have full
  access:

  ```json
  {
  	"package_id": "release-notes",
  	"team_slug": "writers",
  	"preset": "contribute"
  }
  ```

- `packageCollaboratorRemove` (`{ "package_id": "…", "grant_id": "…" }`) removes
  one collaborator, including an outside collaborator.

These run through `accessGrant` and `accessRevoke`, so they are checked and
audited the same way.

## On the web

People with Manage on a package see a **Collaborators** tab on the package page
(`/@owner/<package>/collaborators`). It lists who has access and their preset,
adds a team or org member, changes a preset, and removes access, using the
package collaborator calls. Outside collaborators are listed and can be removed;
their access is changed through `accessGrant`. Org owners always have full
access and are not listed.

In a personal org there are no members or teams to add, so the tab invites
people instead:

- **Invite a collaborator** takes an email or username and a preset: **Use** to
  run it and read the source, **Contribute** to also update it, or **Manage** to
  also publish, delete, and choose who else has access. It calls `inviteCreate`
  with `kind: "grant"`.
- The invite message is shown once, with a copy button. Send it to the person so
  their agent can call `inviteAccept`. Open **Details** to see the message.
- **Pending invites** lists invites that have not been accepted. **Revoke**
  calls `inviteRevoke`.
- Once the person accepts, they appear under **Who has access** as an outside
  collaborator. **Remove** calls `packageCollaboratorRemove`.

The tab also links to creating a team org for group sharing through members and
teams. Team orgs use member and team controls on this tab.

## Open API

The same calls are on the [Open API](/docs/open-api) (`/openapi.json`):

| Call                                                        | Capability                  |
| ----------------------------------------------------------- | --------------------------- |
| `GET /v1/packages/{package_id}/collaborators`               | `packageCollaboratorList`   |
| `POST /v1/packages/{package_id}/collaborators`              | `packageCollaboratorSet`    |
| `DELETE /v1/packages/{package_id}/collaborators/{grant_id}` | `packageCollaboratorRemove` |
| `POST /v1/access/grants`                                    | `accessGrant`               |
| `POST /v1/access/grants/{grant_id}/revoke`                  | `accessRevoke`              |
| `POST /v1/access/invites`                                   | `inviteCreate`              |
| `POST /v1/access/invites/{invite_id}/revoke`                | `inviteRevoke`              |

## Invite someone who has no access yet

`inviteCreate` with `kind: "grant"` sends the same grant to an email address or
username. The token is shown once, with a prompt for the invitee's agent:

```json
{
	"kind": "grant",
	"email": "jesse@example.com",
	"resource_type": "package",
	"resource_id": "<package id>",
	"preset": "use"
}
```

The invitee calls `inviteAccept` with the token, or chooses **Accept** on the
invite card on their Waiting page (an email invite needs a verified email
there). Nothing attaches before they accept. Invites expire after 7 days;
`inviteRevoke` cancels a pending one.

Use `kind: "membership"` to add someone to the whole **team** org instead (with
a role and optional teams). Members hold the org-level basics plus what they are
granted. Owners hold everything. Membership invites are refused on a personal
(signup) org; create a team org to invite people.

Personal orgs can still grant Use/Contribute/Manage on packages via
`accessGrant` / `inviteCreate` `kind: "grant"` and revoke with `accessRevoke`.
The web Grants page is aimed at team orgs. In a personal org, invite and remove
collaborators from the package's [Collaborators tab](#on-the-web), or use those
capabilities.

## What a collaborator can do

Someone who holds a grant but is not a member is an **outside collaborator**.
They must connect with **your** org selected at consent. Then they can:

- Read and run the packages they hold Use on
- Run ad hoc code that imports those packages
- Search the shared catalog

They cannot see anything else in your org, reveal secret values, or change a
package unless the grant says so.

### Who pays when a Use collaborator runs your package

The org is the billing boundary, and a connection is billed to the org it is
bound to. Jesse connects with the **owning** org selected, so everything his
runs use is charged there:

| Meter                                                                | Charged to                     |
| -------------------------------------------------------------------- | ------------------------------ |
| Usage events, credits, org and per-user budgets, outbound fetch      | **Owning org** (the bound org) |
| Daily and weekly **execute** limits (unique execute workers per day) | **Owning org's** execute pool  |

Execute limits are one org-wide pool that grows with the org's paid seats. A
grant-only collaborator draws from the owning org's pool but is not a seat, so
granting someone Use does not change your seat count or grow your pool. Nothing
from these runs is charged to the collaborator's personal plan.

Example: Jesse has Use on `@acme/bot`. Connected as `@acme`, a run debits acme's
credits and budgets and counts against acme's execute pool. Jesse's own
personal-org limits are untouched. See
[Organizations](/docs/organizations#execute-limits-one-org-wide-pool) for how
the pool is sized.

### Secrets and integrations on a granted run

Every run acts as a person, and a credential resolves only when that person
holds Use on it. When Jesse runs **your** package in your org:

- Secret **values** and integration tokens come from **your** org
- Jesse never gets `secret:read` from a Use grant
- Each secret or integration the package reads needs Jesse's own `secret:use` or
  `integration:use` on it. A Use grant on the package does not include them;
  grant them on the credential: `accessGrant` with `resource_type: "credential"`
  and the `credential_id` from `secretList` (or `integrationList`,
  `mcpServerList`, `secretProviderList`). The grant follows the credential if it
  is renamed, and ends if it is deleted
- The package rules then narrow that use: `package:execute` on the package, and
  each secret or integration must allow that package (host allowlist,
  `allowed_packages`, or self-authored rules for user secrets)
- The same applies to `{{secret:…}}` in Jesse's own ad hoc code

See [Secrets](/docs/secrets) for placeholders and allowlists.

### Triggers in a shared package

A package's jobs, subscriptions, and webhooks run only for people who turn them
on for themselves with `enablementEnable`, and each run acts as that person with
their live access. If Jesse turns on the nightly job in `@acme/bot`, it runs as
Jesse, with Jesse's grants, and pauses if he loses access. Usage still counts
against `@acme`. See
[Organizations](/docs/organizations#automation-runs-as-the-person-who-turned-it-on).

## Share with a link

The package's [Collaborators tab](#on-the-web) also has **Share with a link**,
in personal and team orgs alike, for when you do not know the person's email or
username. Pick a preset, how many people may use the link (1 by default; blank
for anyone who has it), and how many days it lasts (7 by default, up to 365).
The link is copied once; Kody keeps only its hash.

Whoever opens the link sees what it gives: the package, the preset, and who
shared it. They can create an account first if they do not have one. Opening the
link changes nothing; they choose **Accept** or **Decline**. A signed-in person
who opened it also finds it on their Waiting page and in the Invites panel on
their Organizations page (`/account/organizations`) until they accept, decline,
or the link stops working.

Accepting grants the preset on that one package. Someone who is not a member of
the owning org becomes an **outside collaborator**; the link never adds anyone
to the org. Accepting never lowers access: a person who already has Manage keeps
it when they accept a Use link, and an Owner already has everything.

Each person can use a package link once. If you later remove them, the same link
does not let them back in; send a new one. The tab lists active links with their
uses and expiry, and **Revoke** stops one immediately. Links stop working when
they expire, run out of uses, the package is deleted, or the person who made the
link loses access. Creating, revoking, and accepting a link are in the org audit
log (`invite_link.created`, `invite_link.revoked`, `invite_link.joined`).

## Cross-org imports

A package imports only packages from its own org. A package in org A cannot
import a package from org B, even with a grant. To reuse another org's public
package,
[fork](/docs/package-lifecycle#fork-a-close-public-package-before-creating) it
into your own org and import the copy.

## Which call to use

- Who has access to one package: `packageCollaboratorList`
- Add a team or org member to one package, or change their preset:
  `packageCollaboratorSet`; remove one with `packageCollaboratorRemove`
- One person or team, already known: `accessGrant`
- Someone without access or an account yet: `inviteCreate` with `kind: "grant"`,
  or a link from **Share with a link** on the Collaborators tab when you do not
  know their email or username
- The whole org: `inviteCreate` with `kind: "membership"` or `orgMemberUpdate`
- Take access away: `accessRevoke` (a grant) or `orgMemberRemove` (a member)

Search these names first and open capability detail for the exact call shape.
