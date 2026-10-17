# Billing, credits, and usage

Plan, checkout, portal, prepaid credits, and entitlement usage.

## How to get there

`/@:orgSlug/-/billing` (success `/@:orgSlug/-/billing/success`, portal
`/@:orgSlug/-/billing/portal`) and `/@:orgSlug/-/usage` (credits are its
`#credits` section). Billing and usage belong to the organization in the URL.
Owners and billing admins subscribe and manage; members get 403 from checkout,
the portal, and usage. Team organizations buy one Pro seat per owner and member.
`/account/usage` redirects to the personal org's usage page. `/account/credits`
redirects to its credits ledger, preserving the query. Historical top-up return
URLs still reach the usage Credits section to confirm the Stripe session.
Billing also shows the signed-in user's referral share link and reward status.

`/@:orgSlug/-/credits` is the organization's credits page and is open to every
member. Owners and billing admins (`billing:read`) see the balance, the
organization's default per-person and automation budgets with this month's
spend, and the full credit ledger (purchases, auto-refills, grants, and usage
debits with the meter, units, and month) with the balance after each row, newest
first. **Load older** uses the native credits read with a cursor. Free
organizations still see any balance and history they have. Members and
collaborators without `billing:read` see only their own monthly budget and its
spend. The workspace rail lists **Credits** for everyone in the organization.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@user-me/-/billing
npm run control-kody -- browse --origin <preview> --path /@user-me/-/usage
npm run control-kody -- browse --origin <preview> --path /@user-me/-/credits
```

Do not complete a real Stripe checkout or credit top-up from a Cloud Agent.
Preview deploys have no Stripe keys, so checkout reports unavailable billing
there. Checkout sells only Pro ($12/month or $120/year). Promo codes are typed
on the Kody billing page (Stripe Checkout has no code box), apply to new monthly
subscriptions only, and are rejected on annual before any Stripe call. Retired
Standard and $49 Pro subscribers keep their plan and see a prorated **Switch to
Pro** through the Stripe portal. Deleting an account refunds unused paid
subscription time automatically.

The usage page's Credits section is the prepaid wallet for the purchasable Pro:
balance, packs ($10 / $25 /
$50) or a custom amount, auto-refill (threshold at
least $5, amount, and monthly
cap), notification checkboxes, How far credits go, the How credits are charged
rate card (Worker compute and Rows read debit rates), and credit history. The
native usage read carries it as `credits`. Other plans see a single
switch-to-Pro prompt with no purchase UI; operator plans have no Credits
section. Top-up Stripe returns land on `/@:orgSlug/-/usage?topup=success`, which
confirms and redirects to `/@:orgSlug/-/usage?credits=added#credits`. Usage
above the monthly include debits a funded wallet; nobody is invoiced for
overage. Every newly created person account receives a $5 house grant (held
until the account is credit-eligible Pro). Grant extra credits to a test account
from `/admin/users/:stableUserId` (admin only) instead of paying.

Directly under the included-compute period total, **Where it went** ranks
packages by past-include credits (plus one **Ad hoc** row for direct execute and
unattributed debits). Expand a package row for the compute vs Rows read split
and a package link; expand Ad hoc for a cumulative graph. The same period total,
split, and cumulative graph appear on the owner package settings page. Customer
copy never says UWD.

`/@:orgSlug/-/usage` and `usageGet` lead with activity (code executions, job
runs, workflow runs, package calls). Worker compute and Rows read are an include
bar capped at 100%, with past-include usage as dollars on credits. Free sees
those meters as informational counts; execute caps are the Free limit. Alarms
fire only when the wallet or access is at risk. Public-ladder execute and
outbound fetches show today and this UTC week (Monday–Sunday); whichever window
hits first blocks. The usage warnings panel titles **Limit reached** when a hard
daily/weekly/stock cap is at 100%, and its link points at `#credits`. Referral
share links set a one-week last-wins `kody_ref` cookie; signup persists the
referrer then. Referral rewards fire on the referee's first qualifying paid
Stripe invoice (not a trial) after both emails are verified; do not invent a
paid invoice from this environment. Package credit attribution for the usage
dashboard filter is `usageByPackageGet` (`GET /v1/account/usage/by-package`).

## Transport

Billing and credits forms use native Start server functions. The official API
`GET /v1/account/usage/by-package` (`usageByPackageGet`) remains supported.
