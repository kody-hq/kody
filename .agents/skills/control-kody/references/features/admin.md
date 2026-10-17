# Admin

Operator tools. Seed and preview users are **not** admin.

## How to get there

`/admin` and its children (`/admin/users`, `/admin/roles`,
`/admin/reserved-usernames`, `/admin/feature-flags`,
`/admin/platform-integrations`, `/admin/provider-marks`, `/admin/codemods`,
`/admin/community-reports`, `/admin/insights`, `/admin/platform-feedback`,
`/admin/system-email`). `/admin/insights` shows launch MRR, paid mix, the
stamp-based activation funnel (overall and since 2026-09-10), the Analytics
Engine onboarding funnel (unique users per stage for 7 and 28 days; sampled
floor), active-user windows, MCP client mix, entitlement ladders, open platform
feedback, and estimated Dynamic Worker cost vs catalog list pay, with a Risk
panel for catalog-paid accounts over list MRR, unpaid users at
≥$1 / 500 unique days
(50% of the $2 included-bucket alert), and Standard/Pro
rows whose `stripe_price_id` is missing or not in the catalog.
`/admin/users/:stableUserId` shows the same cost-vs-pay estimate for one
account, plus Durable Object duration (Cloudflare-measured GB-s beside the
StorageRunner RPC wall-clock proxy), the shared usage metric series (including
observe-only Dynamic Worker CPU), and a Credits panel: balance, credit
eligibility (purchasable Pro or admin eligibility), a grant form (dollars plus
an optional note; works on the signed-in admin too), and the recent ledger with
the granting admin for grants.

## Drive it

```bash
node tools/control-kody.ts request GET /admin 403
```

403 on the seed account is success. Local `kody@example.com` is admin; do not
use it unless the change is an admin surface. The users list accepts
`verification=stalled` for unverified person accounts whose latest signup/verify
send is still `accepted` after 60 minutes. `/admin/users` can create a
pre-verified account and show a password-setup link. Operators run one bounded
unverified-account purge pass with `adminUnverifiedAccountPurgeRun` (`dryRun`
previews the next claim page; results carry stable user ids).

## APIs

Admin reads and mutations use native Start server functions with admin
authorization. The preview seed cannot access them.

## Gotchas

- `/admin/feature-flags` Audience is `everyone` or `experiments_opt_in`. That
  audience only includes users who opted in at `/account/experiments`. Per-user
  overrides win over the audience gate.
- `/admin/platform-integrations` rows have `enabled` (hard kill) and
  `visibility` (`draft` | `published`). Only enabled + published apps are
  discoverable. Moving a live app to draft hides it without breaking existing
  connections.
