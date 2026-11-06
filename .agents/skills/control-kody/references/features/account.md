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
(not a direct POST; the page calls a Start server function).

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

## Search and commands

The search button beside the avatar and Cmd+K (Ctrl+K on Windows/Linux) open
search from both workspace and site headers. Verify with a populated workspace:

- Arrow keys select, Enter opens, Escape backs out and returns focus.
- `repo:`, `job:`, `credential:`, `memory:`, `workflow:`, and `doc:` filter
  resources. `>` limits results to commands and destinations.
- Switch the search workspace and verify results stay scoped to it. Collaborator
  accounts must not get member-only navigation or resource results.
- Cmd/Ctrl+P favorites a result. Reopen and reload to verify persistence.
- Cmd/Ctrl+Right opens result actions. Jobs expose run/pause/resume with a
  confirmation step. Workflow pages expose cancellation for active runs; MCP
  server pages expose tool refresh. Repository pages add their own tabs.
- Keyboard shortcuts supports recording, conflict detection, reset, and saved
  direct navigation bindings. Ordinary input typing must keep working.
- Search credential names and check that values never appear in the menu.

Regression coverage: `e2e/command-menu.spec.ts` and the command model, catalog,
and server search unit tests.
