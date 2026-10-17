# Community listings and profiles

Public catalog and owner-scoped package URLs. Public and private packages share
the same `/@username/:kodyId` surface; visibility is the only gate.

## How to get there

`/community` → `/@username/kody-id`. Human share URL: `/@username/kody-id`
(never construct `/community/{listing_id}` for people). Files:
`/@username/kody-id/tree/:ref` (`:ref` is the repo default-branch name, a SHA,
or another branch — leftover `/files` and `HEAD` 301 there). Media in that tree
previews from `/@username/kody-id/raw/:ref/…`. Owner settings:
`/@username/kody-id/settings`. Profile: `/@username`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /community
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

Check catalog, profile, file navigation, and the two-click install control in
the browser. Raw files and README assets remain explicit HTTP resources.

## Gotchas

- Profiles are public catalogs (packages, ratings, forks). There is no follow
  graph, bookmark-star, or social timeline.
- Files, tree, and raw media URLs are public read for listed packages and
  owner-only for private ones. `/raw/` serves any file as inert bytes (sniffed
  media keeps its type; text is `text/plain`, binaries download) and 404s every
  denial.
- README `![alt](./docs/poster.png)` images render from
  `/@owner/<package-name-leaf>/assets/…` (or `/community/:listingId/assets/…`
  when the leaf is a reserved ingress segment) only when the viewed README
  commit is the published or pinned blob `/assets/` serves. Remote image URLs
  stay links.
- Package settings 404 for anyone who is not the owner.
- Listings install from a fork icon beside the package name. Listings from
  another account (including `@kody/*`) use `createDoubleCheck`. The tooltip is
  `This was built by another user. Verify it before using. Click again to confirm fork.`
  The first click arms that control. The second click sends `acknowledged: true`
  (the install operation rejects requests without it). Clicking elsewhere,
  navigating, or leaving the control clears the armed state.
- Admin **featured** is editorial catalog placement on `/community` and listing
  detail (and slim names in the onboarding persist-prompt payload). It is not a
  wizard Step 2 card.
- Catalog cards show **Fork outdated** when the listing pin is not an ancestor
  of the fork tip, or **Fork ahead** when that pin is already in the fork
  history (website UI only). The listing detail page uses a link-break icon for
  that outdated action and a **Fork ahead** badge. SHA inequality alone is not
  enough. That is separate from **HEAD ahead of published** on the package Repo
  tab.
- Own-profile **Needs republish** (`listing=ahead`) is listing pin behind
  `published_commit`. Guests do not see that filter.

Web installs target the personal organization. Team forks use the org-scoped MCP
communityFork capability.
