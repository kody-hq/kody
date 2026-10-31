## Billing ownership and seat reporting

Billing controls live on organization pages; user details link to the personal
organization and retain only metadata, including credentials/privacy copy.
Legacy user-targeted billing tools are deprecated forwarders. Seat sync emits
`billing_seat_quantity_synced`, and admins can query aggregate history with the
read-only `adminOrgSeatQuantityReport` capability.

# Admin

## Seed / reach

Non-admin seed (`jane@example.com` / preview `me@kentcdodds.com`) expects 403.
Local admin: `kody@example.com` / `ilikecode`.

```bash
npm run control-kody -- login
npm run control-kody -- request GET /admin 403
```

## Assert

- `/admin/`, `/admin/$`, `/admin/users`, `/admin/orgs`, `/admin/orgs/$orgSlug`,
  `/admin/feature-flags`
- Organization inventory and detail reads include lifecycle state, seats,
  budgets, and wallet history. User detail links memberships to their org view;
  Deleted users remain read-only.
- Prefer local admin + unit/Workers tests; do not use the shared preview seed as
  admin
