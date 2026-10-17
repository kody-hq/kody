# Packages

Repo-backed saved packages: list, detail, files, approve-publish.

## How to get there

`/@username` lists your repositories — saved packages and plain repos —
including private and unpublished ones when you view your own profile. The page
heading and account rail label are **Repositories**; the list routes are
`/@username` and `/@<slug>/-/repositories`. On a team org,
`/@<slug>/-/repositories` lists the packages that org owns, filtered to what the
member can see (`canSeeResource`), plus every plain repo the org owns (members
who can open the page see all of them; there is no per-repo grant). Former
`/@<slug>/-/packages` URLs 301 to `/repositories` and keep the query string.
Chip filters (`visibility`, `listing`, `hidden`, `package`, `app`) and sort
(`sort=updated|created|name`, `dir=asc|desc`) run client-side from the
already-loaded list (behind a `<details>` Filters disclosure; no loader, no view
transition). Default sort is updated descending (`updated_at DESC`); name
defaults to ascending. `package=yes|no` is whether the row has the saved-package
extension — distinct from `app=yes|no` (Has app / No app). Own-profile GET
params: `visibility=public|private`, `listing=published|unpublished|ahead`
(ahead = **Needs republish**: rare sync lag when the listing pin is briefly
behind `published_commit` after promote; not HEAD-ahead-of-published),
`hidden=yes|no`, `package=yes|no`, `app=yes|no`, `sort=created|name`, and
`dir=asc|desc` (omit `dir` when it matches the sort field's default). Guests can
use `listing=published|unpublished`, `package=yes|no`, `app=yes|no`, `sort`, and
`dir`. Owner-only params are ignored for them. Search is `q=` and filters the
already-loaded list as you type (URL `replaceState`, no loader). Each row shows
Iconic signifiers (native tooltip only) for package or repo, private, hidden,
published to Community or not published to Community (packages only), webhook
count, job count, and whether it has an app. Private repositories do not also
get a “not published to Community” signifier — the private icon is enough. List
marks come from `/@username/:kodyId/icon/:iconCommit` for both packages and
plain repos (the route falls back to `entity_kind:'repo'` with the same access
as the detail page). `/account/repos/:repoId/icon/:iconCommit` remains the
MCP/owner-only lane. Each repository lives at `/@username/:kodyId` (the URL slug
is the package or repo name leaf; **Repo** tab: description, tags, license,
badges), `/@username/:kodyId/tree/:ref` (**Files** tab),
`/@username/:kodyId/assets/…` (README-relative images from the published or
pinned commit), `/@username/:kodyId/settings` (**Settings** tab for packages:
lock, forkable visibility, internet-visible, webhooks, delete),
`/@username/:kodyId/collaborators` (**Collaborators** tab, shown only with
`package:manage_access`: teams, org members, and outside collaborators with
their preset; add a team or org member, change preset, remove),
`/@username/:kodyId/approve-publish` (published-vs-HEAD review), and
`/@username/:kodyId/approve-capabilities` (credential/capability summary before
internet-visible). `/@:orgSlug/-/approvals/:bundleId` is an agent-prefilled
bundle of pending approvals across packages (`approvalBundleCreate`), with
Approve all and per-item Approve or Deny; only the person it was made for can
open it. Opening an allowlisted image or video in the tree renders a preview;
the bytes come from `/@username/:kodyId/raw/:ref/…` (same authz as the tree, 404
on every denial). Every file view links that URL as **Raw**; agents can fetch it
with `Authorization: Bearer kody_at_…` (`package:read`). `/account/packages`
404s. `/account/packages/:packageId` redirects to the canonical package page.

## Drive it

Preview seed has **no** packages until you create one. Package creation is
MCP-only (`packageGetGitRemote({ create: true, kody_id })` with the package name
leaf or `@owner/leaf`). Use the CLI — logged-in preview testing does not require
agents to hand-roll an MCP OAuth dance — the CLI does it for them:

```bash
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead] [--org <slug>]
```

Then assert the pages:

```bash
node tools/control-kody.ts preview -- \
  --check /@user-me
```

`--head-ahead` pushes one unpublished commit so the Repo tab can show **HEAD
ahead of published**. That flag needs a minted Artifacts write remote.
`--kody-id` is an alias for `--package-name`. To prove delete, create a package
with `package-create`, then delete it and assert the empty state. Arbitrary MCP
fixtures use `control-kody execute` / `search` against the same origin.

## Transport

Package reads, settings, individual and bundled approvals, and Collaborators use
native Start server functions. Collaborator changes require
`package:manage_access` and support granting or revoking internal team/member
access through `packageCollaboratorSet` and `packageCollaboratorRemove`.
Personal packages also create addressed invites by email or username and revoke
pending invites through native Start functions, backed by `inviteCreate` and
`inviteRevoke`. One-time messages stay local to the submitted actor and package.
Existing outside collaborators are listed read-only and can be removed. Raw
files, assets, and icons remain HTTP resources:

- `GET /@:username/:kodyId/icon/:iconCommit`
- `GET /account/repos/:repoId/icon/:iconCommit`
- `GET /@:username/:kodyId/raw/:ref(/*relativePath)`

## Gotchas

- Stay on the preview origin. Do not follow a package-app handoff into
  production.
- Unlocking a locked package is website-only.
- Making a package public or private requires typing the slug. Going public also
  asks the owner to skim source, README, and examples for personal details
  first. Agents review that hygiene before `packageUpdate`
  `changes.visibility: "public"`; they pass `confirm_name` only when going
  private.
- **Forkable** (`visibility` / `is_private`) and **internet-visible** are
  independent. Internet-visible requires a published commit and owner approval
  of the credential/capability fingerprint (no secret values). Turning either
  off requires typing the package slug. Agents requesting
  `changes.internet_visible: true` get an `approval_url` instead of approving.
- When default-branch HEAD is newer than the last publish, owners see **Publish
  changes** on the Repo tab and a **Publishing** panel on Settings (live
  version, who can see it, newer changes, primary CTA). Both open
  `/@username/:kodyId/approve-publish`. Publish checks require non-empty root
  `README.md` and `AGENTS.md`. Promote auto-advances an existing community
  listing; there is no separate Update public listing step.
- Owners see **Open Package App** on the package page when the package declares
  an app. Other viewers do not.
- Own-profile **Needs republish** (`listing=ahead`) is rare listing-pin lag
  behind `published_commit` while sync catches up. It is not
  HEAD-ahead-of-published and not `updated_at` after `published_at`.
