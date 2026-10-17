# Secrets

User, session, and package secret rows. Host approval and package grants.

## How to get there

Canonical pages are `/@<slug>/-/secrets` (and `/@<slug>/-/secret-providers`).
Detail stays under `/@<slug>/-/secrets/{user|session|package}/…`, including
`/@<slug>/-/secrets/new` and `/@<slug>/-/secrets/approve`. Prefill agent links:
`/connect/secret-set?name=…` (same family as `/connect/secrets`). Host approval:
`/connect/secrets`. Those org-less pages link back through
`/account/credentials`, which redirects to the signup org's
`/@<slug>/-/credentials`. External providers live at
`/@<slug>/-/secret-providers`. Docs: `/docs/secret-providers`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/secrets
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

Create preview secrets through the secret editor. Verify creation and editing
without exposing secret values in logs.

## Gotchas

- Never paste secret values into chat, PRs, or execute params.
- Preview seed starts with zero secrets. Create one through the secret editor
  before asserting rows.
- `/connect/secrets` rejects hosts that are not hostname-shaped (truncated
  tokens, paths, empty values). Those must not appear as a successful Allow
  target, and they must not land in `allowedHosts`.
- Package grants on user secrets are website-only (`/@<slug>/-/secrets/approve`
  or the secret editor). `secretLock` returns an approval URL; it does not add
  `allowed_packages`. Provider grants are website-only on
  `/@<slug>/-/secret-providers`; `secretProviderLock` also returns an approval
  URL.
