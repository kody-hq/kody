# Account hub

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /account --contains 'Account'
npm run control-kody -- browse --path /account
npm run control-kody -- request GET /account/organizations --contains 'Organizations'
```

Create a team org through the signed-in page (`browse`), then use `/@<slug>/-/…`
workspace pages. For a verification fixture, use MCP `orgCreate` via `execute`
(not a direct POST — the page calls a Start server function).

```bash
npm run control-kody -- browse --path /account/organizations/new
```

## Assert

- Person: `/account`, `/account/security`, `/account/data`,
  `/account/organizations`, `/account/organizations/new`
- Export: `GET /account/export.json`
- Team org: `/@{$orgSlug}/-/overview`, `/@{$orgSlug}/-/settings`,
  `/@{$orgSlug}/-/members`, `/@{$orgSlug}/-/teams`, `/@{$orgSlug}/-/grants`,
  `/@{$orgSlug}/-/collaborators`
- Invite: `/join/$token`
- Public team org page: signed out, `request GET /@<slug>` is 200 for a public
  org (only public, non-hidden packages; no members) and the same 404 as an
  unknown handle for a private one. Members of a public org see an
  **Organization home** link (`/@<slug>?view=home`). Toggle with `orgUpdate`
  `{ profile_visibility }` or the Settings page radios.

Do not delete the shared preview seed to prove account deletion.
