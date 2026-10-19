# Admin

## Seed / reach

Non-admin seed (`jane@example.com` / preview `me@kentcdodds.com`) expects 403.
Local admin: `kody@example.com` / `ilikecode`.

```bash
npm run control-kody -- login
npm run control-kody -- request GET /admin 403
```

## Assert

- `/admin/`, `/admin/$`, `/admin/users`, `/admin/feature-flags`
- Prefer local admin + unit/Workers tests; do not use the shared preview seed as
  admin
