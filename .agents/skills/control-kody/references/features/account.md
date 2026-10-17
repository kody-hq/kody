# Account hub

Pages about the person, split from the org workspace:

- `/account` (Account settings): name, avatar, email, onboarding banner; links
  to the public profile at `/@handle`. Also hosts one-time personal-org
  conversion through its native Start form, which asks for the new personal
  handle.
- `/account/security`: password, links to two-factor and passkeys, sign-in
  providers (Connected accounts), former emails.
- `/account/organizations`: every org you belong to (no "current" marker: an org
  is current only when its slug is in the URL), pending invites (`#invites`),
  soft-deleted orgs you owned that can be restored for 30 days, and Create
  organization.
- `/account/experiments`: experiments opt-in.
- `/account/data`: export and delete account.

Usage lives at `/@:orgSlug/-/usage`, with funding controls in `#credits`. The
credits ledger lives at `/@:orgSlug/-/credits`. Legacy `/account/usage` and
`/account/credits` redirect to the corresponding personal-org page.

The account rail ("Account sections") lists only those pages; it has no
workspaces group. From account pages, orgs are reached through the avatar menu's
Manage group (below) and the Organizations page. Every workspace section is on a
separate "Workspace sections" rail under `/@<slug>/-/…`. That rail groups Build
(Repositories, Jobs, Webhooks), Credentials (Credentials, Secret providers),
Agents & data (Agents, Memories, Email), Activity, and Organization (Usage &
credits and Billing for owners/billing admins). Activity has Activity,
Workflows, and Waiting as tabs under the page title
(`data-testid="account-section-tabs"`, labelled "Activity pages"); the rail item
stays current on all three. Repositories is `/@<slug>/-/repositories`, distinct
from the public profile at `/@<slug>`. Former `/@<slug>/-/packages` URLs 301 to
`/repositories` (query preserved). The signup org's Overview
(`/@<slug>/-/overview`) is a card for every workspace section; a team org's
overview URL redirects to its home at `/@<slug>`. Both rails come from
`account-rail.ts` and render through the account shell navigation in
`packages/worker/start/pages/account-management-components.tsx`. Below 860px a

rail collapses to a `<details>` menu.

The org switcher is the Workspace rail's heading: under the "Workspace" label,
the org name is a button (`data-testid="org-switcher"`, "@slug: switch
organization", panel `org-switcher-panel`) that lists orgs (avatar, `@slug`,
role, check on the rail's org), then Create organization and an invites row when
you have any. Each org row keeps the current section when that org can open it,
otherwise it opens that org's workspace home (`workspaceSwitchHref`). Below
860px the same switcher is the first item in the rail's `<details>` drawer
(`org-switcher-drawer`, panel `org-switcher-drawer-panel`). The account rail has
no switcher and no org list. Source:
`packages/worker/start/components/workspace-switcher.tsx`.

The site header has one session control, the account menu
(`data-testid="account-menu"`, panel `account-menu-panel`): the person's avatar,
name and `@username`, then a **Manage** group (`account-menu-manage-group`) with
one `@<slug>` row per org (person icon for the signup org, people icon for
teams). The URL's org leads when the page has one; otherwise the signup org
does. Each row opens that org's workspace home (team `/@<slug>`, signup org
`/@<slug>/-/overview`). Then Public profile, Account settings, Organizations,
Usage & credits (current org from the URL only, else the personal org), and Log
out. So pages without a workspace rail (packages, org homes, account pages)
still reach every org. Narrow viewports fold the account menu into the one menu
panel (`site-menu-account`: Manage, then a "Your account" group). Own public
profile (`/@<username>`) also links **Workspace** (lands on
`/@<slug>/-/repositories`) beside Account settings. A team org home lists
**Workspace** above its management links.

## How to get there

`/account` after login. Create an organization at `/account/organizations/new`
by submitting the organization form; it navigates to the org home at `/@<slug>`.
Account deletion is on `/account/data`. Both actions use Start server functions.
Team-org settings, members, teams, grants, and collaborators are
`/@<slug>/-/settings`, `/@<slug>/-/members`, `/@<slug>/-/teams`,
`/@<slug>/-/grants`, and `/@<slug>/-/collaborators`.

A non-personal org handle (`/@<slug>`) renders the org home for its members and
404s for everyone else. Secrets, jobs, and the other org resource pages read
`request.org.id`. Agents (`/@<slug>/-/agents`; old `/-/connections` URLs 301
there) lists the viewer's own agents approved for that org (members and
grant-only collaborators). Repositories (`/@<slug>/-/repositories`) lists the
packages a team org owns that the member can see (Owners see all, other roles
see what their grants and teams give them); rows do not link to a package page
yet. A team org's Organization group lists Members (with Members, Teams for
owners/members, Collaborators, and Grants as tabs), Settings, and Billing
(`/@<slug>/-/billing`, owners and billing users). A personal org's Organization
group lists Grants and Billing. The org home and `/account/organizations` also
link into those sections. The switcher keeps the current page in the destination
org when that role can open it there (for example Secrets to Secrets);
otherwise, and from a page with no org section (such as `/account`), it opens
that org's home.

Resource pages (packages, secrets, jobs, and the rest) live under
`/@<slug>/-/…`. `/account/...` resource pages 404, except
`/account/packages/:packageId`, which redirects to `/@username/:kodyId`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /account
npm run control-kody -- request GET /session --origin <preview>
```

Profile, organization membership, avatar, email, deletion, and logout actions
use native Start server functions. Test the relevant forms and confirmations in
the signed-in browser. `GET /account/export.json` remains the metadata export
protocol.

## Gotchas

- Seed users start empty. Profile fields exist; packages/secrets/jobs do not
  until you create them.
- A successful account deletion clears the session and the account page
  navigates to `/?accountDeleted=1`. The homepage status
  `data-testid="account-deleted-notice"` reads "Your Kody account has been
  deleted". Do not delete the shared preview seed to prove this.
- Connected agents (inbound MCP hosts) are a workspace page:
  [connections](./connections.md) at `/@<slug>/-/agents`.
- Linking a sign-in provider returns to `/account/security?oauthLinked=<id>`.
- Former-address release starts in the account UI, then confirm at
  `/verify-email-claim-release`. It drops the claim without reminting
  `users.stable_user_id`.
- Email destinations are managed on the [email inbox](./email.md).
