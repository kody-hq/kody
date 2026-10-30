# 0065 — Org seats and prepaid credits

- **Status:** accepted (amended 2026-10-10)
- **Date:** 2026-10-09

## Context

Teams P6 billing treats each organization as the entitlement and wallet
boundary: seats bill Owners and Members on the existing Pro subscription
(quantity = live seat count), prepaid credits cover usage past the monthly
include, and org-level defaults plus per-user budgets cap spend for members and
outside collaborators. Kent settled pricing at $12/mo or $10/mo on yearly seats,
one monthly include per paid org, two free orgs per user, billing emails to
owners plus the billing role, and budgets that apply to outside collaborators.

[ADR 0051](./0051-include-credits-stop.md) chose **include → credits → stop**
for purchasable Pro on personal accounts. Org billing uses the same customer
story for usage past the include. Stripe must resolve org identity on new
objects via `kody_org_id`; migrated personal orgs keep `kody_stable_user_id` in
metadata (same id as `orgs.id`).

As first accepted, this record dropped a paid org with
$0 credits to Free rate,
compute, email, and job-interval limits. That cut paying Pro accounts below the
include they pay for. Kent reversed it on 2026-10-10: a Pro org at $0
keeps its full include and is never downgraded.

## Decision

- **Usage path for paid orgs:** **include → credits → stop**
  ([0051](./0051-include-credits-stop.md)). At $0 credits the org keeps every
  Pro include (rates, email, job interval, monthly Worker compute and Rows
  read). Usage past the include stops with a message to add credits; it never
  falls back to Free limits.
- **Seats:** The existing Pro subscription with **quantity = live Owners +
  Members**. Billing-only and outside collaborators are **not** seats.
- **Rate pool (2026-10-10):** Daily and weekly rate limits are one org-wide pool
  of live seats × the per-seat Pro include, and the credits ceiling scales the
  same way ([0051](./0051-include-credits-stop.md)). They are not keyed per
  member. The monthly Worker compute and Rows read includes stay one per org.
- **Kody-only Stripe mutations:** Billing code may only read-modify
  subscriptions that carry a known Kody price (purchasable Pro or retired
  Standard/Pro ids) or Kody metadata (`kody_org_id`, `kody_stable_user_id`,
  `kody_plan`). Shared-account products such as GratiText Premium must never be
  listed as "the" Kody subscription for seat sync, portal plan changes, or
  account-deletion cancels.
- **No P6 price migration:** Existing subscribers inherit their current
  subscription exactly, including retired prices. P6 does not move anyone off a
  retired price and does not change quantity on retired-price subscriptions.
  Seat quantity sync applies only to purchasable Pro (current seat) prices. Any
  retired-plan price migration is a separate customer-facing decision.
- **Free org cap:** Each user may own at most **two** organizations whose
  effective plan is free. Creating or accepting ownership of another free org
  requires upgrading or deleting an existing free org.
- **Plan resolution for seat sync and the live free-org cap:** use the effective
  plan, the higher of the manual grant and Stripe plan; temporary promo/gift
  overlays are excluded because they are not subscriptions.
- **Deleted-org restore:** classify the tombstone by its manual plan because
  soft-delete cancels Kody subscriptions and its stored Stripe plan is stale.
  The restore cap still counts other live orgs using their effective plans.
- **Stripe metadata:** New checkout, subscription, and customer objects set
  `kody_org_id`. During personal-org dual-resolve, also set
  `kody_stable_user_id` to the same org id; migrated orgs continue to rely on
  `kody_stable_user_id` until cleanup drops the legacy key.
- **Billing notifications:** Email owners and users with the billing membership
  role for invoice and payment events.

## Consequences

- Entitlement and metering code must branch on org plan, wallet balance, and
  seat count. An empty wallet resolves to the Pro include table; the 0051 stop
  covers usage past it.
- Seat quantity sync must ignore billing-only and collaborator memberships.
- Seat sync, checkout portal updates, and account-deletion cancels must use
  {@link selectKodyPlanRetainingSubscriptions} (or equivalent); status-only
  filtering is unsafe on the shared Stripe account.
- Webhooks and checkout success handlers resolve org id from metadata
  (`kody_org_id` first, then `kody_stable_user_id`).
- Customer copy must not use em dashes. Describe the $0 state as usage past the
  include stopping until credits are added, not as unlocking or lifting tiers.
