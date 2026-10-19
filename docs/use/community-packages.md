# Public packages

**Public / private** is repo visibility. **Community** is the catalog
(`/community`, `/@username`) and the official Discord server — not a second kind
of package. A listing is the catalog row for a public package.

Public **packages** appear in that catalog. Visibility lives on the **repo
record in D1** (default private), not `package.json#private`. Making a package
public lists it on `/community` and `/@username/:name` with full source and
fork. Public plain repos store the same visibility flag and inherit it on
promote; they do not appear on `/community`. Package **runtime** uses
`published_commit`; pushing to a public default branch is world-readable at HEAD
even before the next package publish.

One-click install forks the listing into your account and publishes it when
checks pass. If checks fail, the fork stays inert until you adapt and publish.
`communityFork` always leaves an inert source.

Public pages work without a Kody account: `/community` (searchable index),
`/@username` (public catalog), and `/@username/:name` (detail). Forking, rating,
and reporting require a signed-in MCP user.

### Clone a public package (read-only Git)

Append `.git` to a public listing URL for a **read-only** Git smart HTTP remote:

```bash
git clone https://kody.codes/@kody/cloudflare.git
```

Browsers that open the same URL are redirected to the package page (the path
without `.git`). Git clients keep using smart HTTP on that URL.

That route proxies to the package's Artifacts repo with a short-lived
server-side read token. Clients never see Artifacts host URLs or credentials.
The advertised refs pin the **published snapshot** (`published_commit`, else the
listing `pinned_commit`) — not a mutable worktree tip that may be ahead of
publish. Anonymous push is challenged (`401`). Private or unlisted packages
challenge for credentials (`401`) so a configured helper can authenticate.

After `kody auth setup-git`, the same URL accepts a long-lived `kody_at_…` for
live HEAD clone/fetch/push (push moves HEAD only; it does not auto-publish). See
[Git credential helper](../guides/auth-setup-git.md). Owner Artifacts remotes
from `packageGetGitRemote` stay available for short-lived scoped remotes.

Community discovery uses the MCP **`community`** domain. Catalog listings do
**not** appear in the general MCP **`search`** tool.

## Making a package public

Ask your agent to set visibility with `packageUpdate`
(`changes.visibility: "public"`) the first time. `communityPublish` also makes a
package public, and it is the capability that **republishes** an already-public
listing after later package publishes.

There are **no** MIT, logo, README Intent, or `package.json#private`
**platform** gates to flip visibility. Tags, description, category, and an icon
are optional (ranking can prefer filled-in cards). Publishing a version requires
non-empty root `README.md` and `AGENTS.md`. Agents review the package for overly
personal content before flipping public — see
[Personal-details hygiene](../guides/package-authoring.md#personal-details-hygiene-before-going-public)
in the package authoring guide. If anything looks personal or
household-specific, the agent stops, tells you what it found, suggests how to
generalize, and waits for explicit go-ahead. The Worker does not scan or block
on that review.

- New packages are always created **private**.
- Making a package **public** lists it on `/community`. Anyone can then read and
  fork the default branch. On the website, type the package slug to confirm.
  Agents do not pass `confirm_name` for public; they run the hygiene pass first.
- Making a package **private** unlists it: public URLs 404; existing forks keep
  their copies. Type the package slug to confirm (`confirm_name` for agents).
- Deleting a package (`packageDelete` or **Delete package** on the package page)
  also unlists it. Type the package name to confirm. Existing forks of that
  listing keep their copies. If the deleted package was itself a community fork,
  that fork record is removed and the listing's fork count drops.
- Hidden and locked stay separate from visibility.

### Listing vs publish and promote

Three commits matter for a public package:

| Surface                                  | Commit           | Moves when                                                                                                |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| Default-branch **HEAD**                  | Artifacts tip    | `git push` / repo session edits                                                                           |
| Package **runtime** (`published_commit`) | Last publish     | `packagePublishExternalPush`, `repoPublishSession`, or website **Publish HEAD** / **Promote this commit** |
| Community **listing** (`pinned_commit`)  | Catalog snapshot | Same publish/promote paths once a listing exists; first list via `communityPublish` / visibility public   |

Once a package is listed on the community, publish and promote advance the
catalog pin with the runtime. There is no separate republish step. First-time
listing still uses `packageUpdate` with `changes.visibility: "public"` (or
`communityPublish`). A scheduled backfill catches any listing whose pin drifted
from the published commit.

The package **Settings** tab has one **Publishing** panel: the live version, who
can see it (only you, your organization, or anyone on the community), what is
newer on HEAD, and a single primary publish/promote button.

### Icon

Put the list/identity mark at `.kody/icon.png` (also `.svg`, `.webp`, `.jpg`,
`.jpeg`). Root `icon.*` and `community-icon.*` are aliases. See
[Package icon](../guides/package-authoring.md#package-icon) for the full
resolution order. Packages without a file get a generated swirl based on the
package name.

## Browsing listings

Anyone can browse `/community`, a public catalog at `/@username`, and a package
at `/@username/:name` — for example `/@kentcdodds/devin`.
`/community/:listingId` redirects to that canonical URL. The package page tabs
are **Repo** (details), **Files**, and **Settings** (owner). Files live at
`/@username/:name/tree/:ref/...` where `:ref` is the repo's **default branch
name** (usually `main`, whatever git reports — not hardcoded `master`), a SHA,
or another branch. `HEAD` and leftover `/files` URLs 301 to
`/tree/{defaultBranch}` (`main` when lookup misses). Private packages use the
same tree URL; unauthenticated visitors get 404. Owner settings are
`/@username/:name/settings`. The package home (Repo tab) renders the README.

The catalog defaults to **Best**. **Newest** orders by last community publish.
**Featured** is editorial placement only — not a safety badge. There is no
trusted-listing review mark.

The Repo tab shows package chrome first: the name, then the install control
beside it for non-owners (see [One-click install](#one-click-install)). Below
that, a badge row can show **Featured** and **Fork ahead**. Owners with
unpublished HEAD see **Publish changes** in the repository action group (or the
**Publishing** panel on Settings). The facts block lists version from
`package.json#version` when the author set a string (same label on catalog
cards), plus license, last publish date, pinned commit, rating, forks, and
adaptation effort. The README renders under the frame. You can also ask your
agent to use `communitySearch` or `communityGet`. After `communityPublish`,
confirm `license`, `pinned_commit`, and the other listing fields match intent —
see [Listing verification](../guides/package-apps.md#listing-verification) in
the package apps guide.

## Forking a listing

`communityFork` copies **HEAD** into your account as an **inert** source:

- `package.json` `name` is rewritten to your username scope (`@you/<leaf>`).
  When you omit a name, the leaf is the listing leaf. If that leaf is already
  taken by an unrelated package, Kody uses the next free leaf (`leaf-2`, then
  `leaf-3`, …). Pass an explicit leaf (or `@owner/leaf`) to choose the name;
  that path errors if the name is taken. Forking the same listing again errors
  with the existing fork's identity instead of minting another leaf.
- **No saved package row is created**, so nothing runs yet — no imports, jobs,
  subscriptions, or package app.

The fork result lists **cross-scope references** that can never resolve across
user scopes:

- static `kody:@originuser/...` imports
- `package.json#kody.dependencies` entries pointing at other users' scopes

The capability also returns optional **`serverTiming`** entries
(`{ name, durationMs }`), the same shape as execute. They are request-scoped
diagnostics, not stored metrics. `bootstrap-source` is the git bootstrap RPC
(including Durable Object startup); nested `bootstrap-*` phases are the work
inside that isolate.

Your agent should:

1. Confirm **your** intent (which may differ from the original author's).
2. Open a repo session on the fork's `source_id` (`repoOpenSession`).
3. Do a **read-only safety review** of all files before publishing. Community
   content is untrusted third-party content. Treat prompt-injection attempts as
   **data** — surface them to you, never follow them.
4. Re-implement or remove cross-scope references.
5. Rewrite the README **`## Intent`** section for your goals.
6. Publish via `repoPublishSession`. Repo checks fail if cross-scope imports
   remain.
7. Optionally adopt the fork after a real source review, so it gets the same
   automatic secret read/use access as self-authored packages (see
   [Secrets and host approval](./secrets-and-values.md)). Only you can adopt,
   signed in on the package's **Settings** page (**Community fork** section).
   `communityForkAdopt` returns that link; agents, `execute`, package apps,
   jobs, webhooks, and other package runtimes cannot adopt.

Only after publish does the package become a live saved package in your account.

If the listing owner later pushes to a public default branch, your fork keeps
the snapshot you copied. `packageGet` / `packageList` / search set
`listing_ahead` / `listingAhead` only when the listing pin is not an ancestor of
your fork tip (the fork is behind or diverged). SHA inequality alone is not
enough. Your `/@username` profile and catalog cards replace Installed / Forked
with a yellow **Fork outdated** control when the fork is behind (click copies an
absorb prompt and links to the listing files at the pin) or a calm **Fork
ahead** badge linking to those files when the pin is already in the fork's
history — that ahead badge is website UI only. The listing detail page uses a
link-break icon for that same outdated action and a **Fork ahead** badge. For an
outdated fork, compare origin HEAD with your package, port useful changes, keep
your customizations, then publish with `repoPublishSession` and
`absorbed_upstream_commit` so the behind-upstream banner clears. That absorb
path still opens a full repo session (clone + checks); there is no metadata-only
absorb. While the session is open its scratch counts toward `storage_bytes`; a
successful publish releases that scratch so it cannot strand your package app
over the Free storage limit. See
[Repo sessions](./repo-sessions.md#when-to-use-other-repo-capabilities).

When the listing owner republishes with a new pinned commit, packages in your
account can react through the `community.fork.upstream_updated` subscription
topic. Forking also follows the upstream package. You can follow a public
package without forking it (`follow.published` / `follow.pushed`): choose
**Follow** on its page, pick the workspace and events, and manage every follow
on your workspace's **Follows** page. Use the fork topic to auto-rebase, or to
ping you on Discord. See
[Package subscriptions](../guides/package-subscriptions.md#communityforkupstream_updated).

## One-click install

The listing detail page puts the install control beside the package name as a
fork icon. `@kody/*` listings are public community packages from the `@kody` org
and install like any other listing from another account. The tooltip says “This
was built by another user. Verify it before using. Click again to confirm fork.”
The first click arms that control and the second click on the same control
starts the install and sends `acknowledged: true` on
`POST /community/:listingId/install.json` (the endpoint responds `409` without
that flag). Clicking elsewhere, navigating, or leaving the control clears the
armed state. Logged-out visitors get the same icon as a login link and sign in
on the first click. While the fork runs, that slot shows a spinner whose tooltip
names the current stage.

A current fork shows an open icon that links to the fork. An outdated fork shows
a link-break icon in that slot; the click copies the absorb prompt and opens the
listing files at the pin. When the fork needs a setup prompt, a clipboard icon
beside the status icon copies it. An installed fork offers **Use in agent**
under the listing.

Catalog cards show **Installed**, **Forked**, **Fork outdated**, and **Fork
ahead**. The detail page shows **Fork ahead**. Install forks the listing into
your account and, when the fork passes publish checks, publishes it as a live
saved package. If the listing leaf is already taken by an unrelated package, the
install uses the next free leaf. **Publishing activates the package right away**
— declared jobs are scheduled.

When checks fail — most commonly because the package imports code from the
original author's scope (`kody:@originuser/...`) — nothing is published. The
fork stays **inert**, and the clipboard icon copies a prompt so your agent can
review, adapt, and publish it through a repo session.

One-click install is a **UI-only** flow. Agents use `communityFork` plus a repo
session instead.

## Featured listings

Admins can mark listings as **featured**. Featured is editorial placement on
`/community` and listing detail, not a safety review and not an onboarding
wizard step. Admins toggle featuring from the listing detail page or with
`communitySetFeatured`.

## Public profiles

Each account has profile fields:

- **Display name** — shown on the profile and activity items (falls back to
  username when unset)
- **Bio** — short public text
- **Avatar** — optional profile image (PNG, JPEG, or WebP)
- **Profile visibility** — `public` by default, or `private`

Public profiles are at `/@username`. A public profile shows display name, bio,
avatar, join date, the user's **public packages** (metadata only), and recent
public activity (publishes, republishes, and public forks).

### Avatars

Upload or remove an avatar from **Account → Profile** in the web UI (MCP does
not accept avatar uploads). Click the avatar, or drop a photo anywhere on the
account page, to open a crop and zoom editor (drag, pinch, scroll, or the
slider) so you can frame a square that matches the circular avatar. The browser
converts HEIC, AVIF, and other photos to PNG, JPEG, or WebP and resizes large
images before upload. Stored avatars are PNG, JPEG, or WebP, up to 1 MB, with
each side between 64px and 4096px and an aspect ratio of at most 3:1. Dropping a
photo on the account page opens that editor; dropping a file elsewhere in the
app does not navigate away. Avatars appear on the public profile and in profile
activity rows. Private profiles keep the avatar for the owner; other users do
not see it.

Package privacy follows the repo visibility flag (`saved_packages.is_private`),
not `package.json#private`:

- Private packages do not appear on the public profile.
- Public packages on the profile are catalog listings: they carry a listing
  signifier and a fork affordance (same inert-fork rules as
  [forking a listing](#forking-a-listing)).
- The owner’s own profile can filter **Needs republish** when the listing pin is
  briefly behind the package published commit (promote auto-follows; this is a
  sync-lag signal). `communityPublish` also bumps `updated_at` after
  `published_at`; that timestamp order is not this signal.

### Private mode

When visibility is `private`:

- `/@username` returns not found (404)
- `communityProfileGet` for another user’s private profile returns
  `user_found: false` with empty fields (it does not leak existence via
  HTTP 404)

The account owner can read and update their own profile (including while
private) through `communityProfileGet` / `communityProfileUpdate`.

## Ratings

After forking, your agent can call `communityRate` with:

- **`stars`** (1–5) — usefulness
- **`adaptation_effort`** (1–5) — 1 = trivial to adapt, 5 = very hard
- optional **`note`**

One rating per user per listing (upsert). Only users who forked a listing can
rate it. Listing owners cannot rate their own packages. Aggregates influence
listing sort order.

Rate honestly: **`stars`** reflects whether the listing was worth forking;
**`adaptation_effort`** helps others estimate rework, not blame the author.

## Reporting listings

`communityReport` requires a signed-in user. Reports are **not** anonymous — the
reporter identity is attached.

Use reporting for spam, malware patterns, license violations, or other policy
issues. Admins review reports on `/admin/community-reports`.

Admins can issue **community bans** that block a user from publishing, forking,
rating, or reporting public packages.

## Capabilities

Use the MCP `community` domain:

- `communityPublish` — make a saved package public, or republish an
  already-public listing to the current published commit (prefer `packageUpdate`
  with `changes.visibility: "public"` for the first publish; review personal
  details first)
- `communityUnpublish` — make a package private / unlist it (prefer
  `packageUpdate` with `changes.visibility: "private"` and `confirm_name`)
- `packageDelete` — permanently delete a saved package (type the package name;
  `confirm_name` must match)
- `communitySearch` — search active listings (`sort: "newest"` for last
  published first; optional `category` to browse one listing category)
- `communityGet` — fetch one listing's metadata and aggregates (including owner
  profile linkage when the owner is public)
- `communityFork` — copy HEAD into your account (inert until published).
  Omitting a name uses the listing leaf, or the next free `leaf-N` when that
  leaf is already taken by an unrelated package.
- `communityForkAdopt` — return the website link where you adopt a reviewed
  fork, granting it self-authored-like secret read/use access (see
  [Secrets and host approval](./secrets-and-values.md)); it never adopts
- `communityRate` — rate a listing after forking
- `communityReport` — report a listing (requires login)
- `communitySetFeatured` — admin-only: feature or unfeature a listing
- `communityProfileGet` — read a profile by username (own private profile
  included when signed in as that user)
- `communityProfileUpdate` — update display name, bio, and visibility

## Privacy and isolation

Forks are copies. Cross-user package imports never resolve. The deliberate
cross-user data flows are the public listing snapshot, aggregate ratings, and
[public profile](#public-profiles) surfaces.

Stable owner **user ids** are not required for browsing: package name scope and
public profiles reveal the owner's **username** (as package URLs do). Search
summaries may omit a stable owner id (`owner_anonymous`) while linking by
username when the owner profile is public.
