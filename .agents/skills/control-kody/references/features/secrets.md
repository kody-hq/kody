# Secrets

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/secrets 302 --contains '/@jane/-/credentials'
npm run control-kody -- request GET /@jane/-/credentials --contains 'Credentials'
```

Create fixtures with `control-kody execute` / `search` (secret capabilities),
not raw D1.

## Assert

- Workspace: `/@{$orgSlug}/-/secrets`, `/@{$orgSlug}/-/credentials`,
  `/@{$orgSlug}/-/secret-providers`
- Connect approvals: `/connect/secrets`, `/connect/secret-set`,
  `/connect/credential`
- Legacy `/account/secrets` redirects or 404s depending on route — prefer org
  URLs
- Credential detail shows **Fill placement** (and **Inject** separately). Edit
  fill placement when the credential is org-owned. `/connect/secret-set` and the
  secrets editor expose the same parts checkboxes (new secrets default
  headers-only).
