# Entitlements (plans and quotas)

## Contents

- [Plan model](#plan-model)
- [Prepaid credits](#prepaid-credits)
- [Compute rate limits](#compute-rate-limits)
- [UserMeter](#usermeter)
- [Schema history](#schema-history)
- [Assigning plans](#assigning-plans)
- [Admin limit overrides](#admin-limit-overrides)
- [Plan lookup](#plan-lookup)
- [The error shape](#the-error-shape)
- [Counting strategy](#counting-strategy)
- [How to add an enforcement point](#how-to-add-an-enforcement-point)
- [Enforcement points](#enforcement-points)
- [Billing](#billing)
- [Related tables and coordination](#related-tables-and-coordination)

Per-user plans with per-plan resource limits. This is Kody's denial-of-wallet
protection for open signup: it bounds how many billable resources a single
account can consume. Stripe subscription billing lives in a separate module
(`packages/worker/src/billing/`); see [Billing](#billing) below. Limit numbers
in `planLimits` stay independently configured from Stripe list prices.

Module: `packages/worker/src/entitlements/` plus the client-safe plan registry
at `packages/worker/universal/plans.ts`.

- `plans.ts` (`#universal/plans.ts`) — plan names (`free`, `standard`, `pro`,
  `max`), the `PlanLimits` config per plan, `proCreditsPlanLimits` and the
  credit wallet unlock (`CreditWalletState`, `resolveCreditWalletState`), the
  pre-cut `legacyPlanLimits` table for continuous Standard/Pro, `max` email caps
  (`maxPlanEmailLimits`), the `EntitlementResource` registry,
  `resolvePlanLimit(plan, resource, ladder?)`, `resolvePlanLimits`,
  `getPlanRank`, `hasHigherPublicPlan`, `parsePlanName` (strict, untrusted
  input), `parseStoredPlanName` (stored-column reads), `parseEntitlementLadder`,
  `resolveEntitlementLadderAfterPaidAccessChange`, and
  `resolveEffectivePlan(manual, stripe)`.
- `errors.ts` — the one typed error (`EntitlementLimitError`) and the one
  user-facing message builder every enforcement point uses.
  `buildEntitlementUpgradeHint` uses `entitlementCreditsOffer` for rate/compute
  includes credits extend (reduce-only once funded, and for `max`); stock and
  other resources keep the upgrade clause only when `hasHigherPublicPlan(plan)`
  (Free). `ComputeOverageLimitError` is the include → credits → stop denial for
  an empty purchasable-Pro wallet past a monthly include.
- `service.ts` — `getUserEntitlement` / `getUserPlan`,
  `getCachedUserEntitlement` / `getCachedUserPlan` (60s TTL enforcement cache),
  `assertWithinEntitlement`, built-in D1 usage counters, the daily-counter
  helpers for rate-style limits, `assertWithinStorageBytesEntitlement`
  (UserMeter DO reserve with cold bootstrap), and
  `readCurrentEntitlementResourceUsage` (UserMeter-authoritative for
  `storage_bytes` and daily resources).
- `second-agent-standard-gift.ts` (universal + worker) — one 14-day overlay of
  Pro on Free when known connected agent ecosystems first reach 2. File, column,
  and helper names say Standard; the overlay uses the retired Pro table without
  a credit wallet. `describeSecondAgentStandardGift` is the flag for lifecycle
  email / PackagedSingleClient. Enforcement goes through `getUserEntitlement`;
  Stripe is not mutated.
- `referral-program.ts` (universal + worker) — uncapped referral Pro credit.
  Share links write a last-wins one-week `kody_ref` cookie; signup persists a
  pending `referrals` row from that cookie. `invoice.paid` grants both parties
  one stacked month after the first qualifying paid invoice. Enforcement
  composes the later overlay with the second-agent gift in `getUserEntitlement`;
  Stripe is not mutated.

## Plan model

The plan registry in `plans.ts` includes `free`, `standard`, `pro`, and `max`.
Every plan has finite numeric limits for every resource; there are no uncapped
tiers and no env-var backstops. Per-org raises are data, not plans: see
[Admin limit overrides](#admin-limit-overrides).

There is deliberately no uncapped plan; the live registry stays finite `max`
only.

`orgs.plan` is a NOT NULL TEXT column with DDL default `'free'` and a CHECK
constraint for the registered names (squashed baseline plus
`0002-restructure-plan-tiers.sql`). Plan, ladder, Stripe, gift, and
credit-eligibility columns live only on `orgs` (personal orgs reuse
`users.stable_user_id` as `orgs.id`). Entitlement reads and writers use the org
row. **Live DDL defaults and writers always persist a known plan name (never
NULL); normal creation and reset paths default to `free`.**

**Write and default:** `resolvePlanWrite` maps nullish admin/API inputs to
`free`, which is the default for new accounts, admin-created accounts, seed SQL,
and admin plan resets. Explicit `max` remains a valid deliberate assignment.

**Reading stored values:** D1 constrains `orgs.plan` to the registered names.
Reads use strict `parseStoredPlanName`: known names pass through unchanged,
while a value that violates the storage contract throws without including the
raw value or user data. Untrusted admin/API input uses `parsePlanName` so typos,
unknown strings, and retired plan names are rejected as validation failures.

Migration `0002-restructure-plan-tiers.sql` maps stored `pro` values to
`standard`, stored `partner` values to `pro`, and rebuilds both CHECK
constraints for the current registry. Migration
`0043-users-entitlement-ladder.sql` introduced the entitlement ladder (now
`orgs.entitlement_ladder`) and backfilled `legacy` for then-active Stripe
Standard/Pro subscribers and manual Pro grants.

`orgs.stripe_plan` stays nullable because it is Stripe-derived; `max` is
manual-only — admin-visible, not paid or public — and never written from Stripe
(`parseStripePlanName` rejects it, along with any retired or unknown name).

`orgs.entitlement_ladder` is `'public'` or `'legacy'` (NOT NULL, default
`'public'`). The public table in `planLimits` is what `/pricing` renders and
what new Standard/Pro subscribers get. `legacy` keeps the pre-cut Standard/Pro
ceilings from `legacyPlanLimits` only while the same Stripe subscription
continues without a plan, price, product, or interval change: same-plan
auto-renew stays `legacy`. Cancel, unpaid, Standard↔Pro, month↔year, or any
other price/product switch writes `public`. A remaining manual Pro grant without
a paid Stripe tier still keeps `legacy` until that grant is removed. The
one-shot backfill in `0043-users-entitlement-ladder.sql` sets `legacy` for those
accounts. Resubscribing does not restore `legacy`.
`0044-users-stripe-price-id.sql` introduced `stripe_price_id` (now
`orgs.stripe_price_id`) so Stripe refresh can detect those subscription changes.
The first observation of a continuing subscription writes the current price and
leaves `legacy` in place. Free and `max` always use `planLimits`; the ladder is
ignored for those plans. Unique-worker-day and Durable Object rows-read numbers
live on `PlanLimits` for the public table. They are not hard-cut and not billed
for legacy accounts.

`getUserEntitlement` / `getCachedUserEntitlement` return `{ plan, ladder }`.
Enforcement (`assertWithinEntitlement`, `consumeDailyEntitlement`, storage
reserve, job interval floors) resolves limits through that pair.

`resolveEffectivePlan(manual, stripe)` compares a non-null manual plan (after
`parseStoredPlanName`) with `orgs.stripe_plan`. Manual `max` always wins over
Stripe; otherwise the higher-ranked of the two is returned. Unknown or null
`stripe_plan` values contribute nothing. Admin user list/get (page and MCP)
expose the grant, Stripe tier, effective plan, and whether a Stripe customer is
linked. `plan` on those records remains the grant that Manage plan edits.

### Second-agent Pro gift

When a user first reaches two known connected agent ecosystems, Kody records one
14-day overlay of Pro. The gate is that second ecosystem (activation), not day-0
signup and not a second OAuth `clientId` for the same ecosystem. Two Cursor auth
contexts are one ecosystem. An unlabeled client does not add an ecosystem.
`orgs.second_agent_standard_gift_granted_at` is the write-once ledger (one gift
per user). `orgs.second_agent_standard_gift_expires_at` is set only when the
base effective plan is still `free`; NULL means the account was already
Standard/Pro/max and Stripe was not touched. There is no existing helper that
extends a remaining Stripe period, and mutating `trial_end` / period end is
payment-adjacent.

`getUserEntitlement` overlays Pro through `resolvePlanOverlay` while
`expires_at` is in the future and the base plan is still `free`. An overlaid
`pro` uses the retired Pro table without a credit wallet (not
`proCreditsPlanLimits`); topping up still needs a Pro subscription (Stripe
customer). The gift never lowers a paid or manual grant. Expiry is read-time (no
sweeper). Authorize completion and grant-list pages (onboarding payload, Account
→ Connections) call `maybeEvaluateSecondAgentStandardGift`, which skips the
write when known ecosystems are below 2 or listing failed, but still reads the
persisted ledger so the onboarding payload does not hide an already-granted
gift. Missing `APP_DB.prepare` skips both write and read.

`describeSecondAgentStandardGift` / `SecondAgentStandardGiftState` is the flag
lifecycle email or PackagedSingleClient should read: `received`, `active`, and
`status` (`none` | `active` | `expired` | `already_paid`). The onboarding loader
exposes that object as `secondAgentStandardGift`.

### Referral Pro credit

Shareable signup links (`/signup?ref=<username>`) set a last-wins `kody_ref`
cookie that expires after one week. A later share link overwrites the previous
referrer for the rest of that window. Signup (password and OAuth) persists a
pending `referrals` row from the cookie or a same-request share link.
First-touch UTMs stay write-once and do not carry the referral code. Reward runs
on `invoice.paid` after the referee's first qualifying paid Stripe invoice
(`amount_paid > 0`, not a $0 trial, not a historical compute-overage invoice).
Both the referrer and the referee receive one stacked month (30 days) of Pro via
`orgs.referral_standard_credit_expires_at` (retired Pro ceilings, no credit
wallet — same as the second-agent gift). There is no annual or lifetime cap on
how many months a referrer can earn. Paid subscribers stack from the later of an
existing credit and the current paid period end so the month starts after paid
access rather than overlapping it. Referee invoices use the latest line
`period.end`. A failed Stripe lookup of the referrer's subscription fails the
webhook so Stripe can retry instead of stacking from now. Email-verify leaves a
held row pending if that lookup fails; the referrer’s later `invoice.paid`
retries it. Stripe subscriptions are not mutated.

Fraud basics before a reward: both emails verified, new-account attribution only
(persisted at signup from the last-wins cookie), no self-referral, no plus-tag /
Gmail-dot email collapse, and no shared Stripe customer. An unverified party
holds the qualifying invoice id on the pending row; email verification retries
the grant. `/@<slug>/-/billing` shows the share link and simple referrer status.

`getUserEntitlement` overlays Pro through the later of the second-agent gift and
this referral credit (retired Pro table, no wallet).

### `max` plan limits

The `max` plan is the operator/manual ceiling: a high finite tier admins assign
deliberately. It is not a public or Stripe-purchasable plan. Email resources use
`maxPlanEmailLimits` because inbound volume is attacker-controlled and outbound
sending is an outreach-abuse surface — `resolvePlanLimit` resolves those caps
like any other limit. The caps stay finite but dominate every other plan's email
limits, so granting `max` never reduces email capacity (`email_message_bytes`
stays at standard/pro parity because the per-message persist ceiling is a
platform bound, not a scalable quota). Compute rate limits on `max`
(`execute_unique_workers_per_day`, `job_runs_per_day`, `concurrent_workflows`)
are operator runaway caps sized from production usage with at least 2× busy-day
headroom, and they still dominate every paid plan. `outbound_fetches_per_day` on
`max` is instead 50× the purchasable Pro include (750,000), because it is also
the per-seat credits ceiling and credits carry outbound fetches to 50× like
execute. `automation_invocations_per_day` on `max` is the public burst-friendly
ceiling above job runs (200,000 vs 40,000). Legacy Standard/Pro automation stays
at the job-matched values. All other resources use the ordinary `planLimits.max`
numbers.

| Resource                         | Limit   |
| -------------------------------- | ------- |
| `email_sends_per_day`            | 10,000  |
| `email_receives_per_day`         | 20,000  |
| `stored_email_messages`          | 100,000 |
| `email_message_bytes`            | 768 KiB |
| `concurrent_workflows`           | 200     |
| `scheduled_jobs`                 | 5,000   |
| `saved_packages`                 | 10,000  |
| `repo_sessions`                  | 20,000  |
| `secrets`                        | 10,000  |
| `storage_bytes`                  | 100 GiB |
| `execute_unique_workers_per_day` | 25,000  |
| `outbound_fetches_per_day`       | 750,000 |
| `job_runs_per_day`               | 40,000  |
| `automation_invocations_per_day` | 200,000 |

## Prepaid credits

The public ladder is Free plus one purchasable **Pro** (`STRIPE_PRO_PRICE_ID` /
`STRIPE_PRO_YEARLY_PRICE_ID`, $12 / $120). Pro uses `proCreditsPlanLimits`: Max
stock/concurrency with Standard rates, email, unique-worker-day and rows-read
includes, and job interval. Free stays hard-capped (execute 150/day and
400/week) with no wallet. Retired Standard ($12/$120) and Pro ($49/$480)
subscribers keep their plan and table until they change plan
(`retiredStandardPriceIds` / `retiredProPriceIds`); checkout only sells Pro.

**Eligibility keys off the Stripe price or an admin decision.**
`resolveSubscriptionPlan` sets `creditsEligible` when the granting subscription
uses a configured Pro price, and every Stripe refresh writes it to
`orgs.stripe_credits_eligible` (`0069-prepaid-credits.sql`). That separates Pro
from retired Standard at the same $12. Because Stripe refreshes overwrite that
column, admins set the separate `orgs.admin_credits_eligible`
(`0070-admin-credits-eligible.sql`) with `adminCreditEligibilitySet`; Stripe
never writes it. `hasStoredCreditsEligibility` ORs the two. `getUserEntitlement`
returns `creditWallet` (`resolveCreditWalletState`): `none` unless the effective
plan is `pro` and the account is eligible (the purchasable Pro price or admin
eligibility), then `funded` when `credit_wallets.balance_micro_usd > 0` and
`empty` otherwise. Free, retired Standard, and `max` are always `none`. Retired
Pro, gift/referral Pro overlays, and manual `pro` grants are `none` unless
admin-eligible. An admin grant to a `none` account only holds a balance. Buying
credits and auto-refill still require the purchasable Pro subscription
(`isPayingForCreditsPro`).

**Include → credits → stop.** This is the one customer billing path for
purchasable Pro, personal and org
([decision 0051](../decisions/0051-include-credits-stop.md); org seats in
[0065](../decisions/0065-org-seats-and-prepaid-credits.md)). The $12 / $120
subscription is the seat plus a monthly include: the retired Standard rates,
email, Worker compute (350 unique worker days), Rows read (5B), and job interval
floor on `proCreditsPlanLimits`. Past the include, usage runs on credits until
they are gone, then stops. A Pro account at $0 keeps the full include; it never
drops to Free limits.

- **Stock is not part of the path.** Purchasable Pro always has Max stock and
  concurrency (repos, saved packages, scheduled jobs, repo sessions, secrets,
  storage bytes, concurrent workflows), empty or funded.
- **Rates are one org-wide pool of paid seats × the per-seat include.** The
  rate/compute fields (execute, outbound fetches, job runs, automation
  invocations, daily and weekly) are counted once per org in its UserMeter, not
  per member, and the include is `proCreditsPlanLimits` times paid seats (live
  owners plus members, at least 1, the same count seat sync bills;
  `countLiveSeats`). A 3-seat org gets 1,500 unique execute workers a day and
  3,600 a week. `resolveUserEntitlementFromRow` reads seats into
  `UserEntitlement.seats`, and `resolveDailyEntitlementWindow` re-reads them
  uncached on every counted rate check, so removing a seat shrinks the pool on
  the next check. Free (one pool at 150/400), `max`, and wallet-less Pro ignore
  seats.
- **Credits ceiling.** With a positive balance, those fields
  (`unlockCreditsLimits`) can reach `creditsUnlockMultiplier` (50)× the pooled
  include, capped at the `max` daily ceilings × seats (per seat: execute 25,000
  a day and 175,000 a week, outbound 750,000 / 5,250,000, job runs 40,000,
  automation 200,000; weekly is seven capped days). Whichever is lower wins: a
  funded 3-seat org gets 75,000 execute a day (both bounds agree) and 180,000 a
  week (50 × 3,600; the 525,000 ceiling never binds for execute). Outbound works
  the same way: the per-seat ceiling is 50× the 15,000 include, so a funded seat
  runs to 750,000 fetches a day and 2,000,000 a week (50 × 40,000).
  `creditsCeilingScalesWithSeats` is the one switch for whether the ceiling
  grows with seats. At $0 `resolvePlanLimits` returns the pooled include (500
  execute/day and 1,200/week per seat), and every one of those fields stops at
  the include (within the 60s enforcement cache) with `EntitlementLimitError`
  copy that says to add credits (`entitlementCreditsOffer`).
- **Monthly meters.** Worker compute and Rows read past the include debit a
  funded wallet (see Debits). At
  $0, `consumeDailyEntitlement` throws
  `ComputeOverageLimitError` for `isPastIncludeStopResource` (execute, job runs,
  automation invocations) once either meter is past this UTC month's include
  (`resolvePastIncludeStop`). The check runs before the UserMeter counter, so a
  stopped attempt spends no daily quota. Hosted package apps have no daily
  counter, so `buildPackageAppWorker` applies `assertWithinComputeInclude` (the
  same rule) to HTTP requests and realtime hooks through a circuit breaker
  (`package-app-usage-breaker.ts`). The breaker never makes a request wait on
  the check: while closed it serves and runs the check after the response
  (`waitUntil`, at most once per org and visitor per 5 s per isolate). A denial
  opens it with a KV deny entry per org and visitor, which refuses requests
  without other reads for a 10 s cooldown. After the cooldown, one request per
  isolate runs the check first (half-open): passing closes the breaker, and a
  denial re-opens it in that isolate (KV is written only on the first open and
  on close). The probe's uncached re-read means a top-up, a raised budget, or a
  new month resumes serving within one cooldown. The trip threshold is `PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT`
  percent of the existing limit (default 100). If the deny entry cannot be read,
  the check runs before serving. Refused HTTP requests get a `429` "Monthly
  include used up" page, and realtime sockets close with `include-used-up`. A
  visitor can therefore get a few seconds of requests past the stop before the
  breaker opens.
  Outbound fetches are exempt from the monthly stop because they happen inside a
  run that was already admitted; their daily and weekly include still stops at
  $0.
  The usage read comes from `usage_rollups` (hourly) behind the 60s entitlement
  cache, so the stop can trail usage by about an hour; a later top-up forgives
  that overshoot instead of charging it. Before throwing, the stop re-reads the
  entitlement uncached, so a top-up resumes work immediately in every isolate.
  The org budget gate runs after the stop.
- Email caps and the job interval floor are not credit-extended; they stay on
  the Pro include whether the wallet is empty or funded. Neither they nor the
  monthly Worker compute and Rows read includes scale with seats yet.

Internally the 50× figure is a ceiling on how far credits go. Customer copy
never frames it as something a balance unlocks, and never names Max; the rate
card in the Credits section of `/account/usage` is where customers see the debit
rates.

**Debits.** The `usage_aggregation` lane runs `runCreditDebits`
(`packages/worker/src/billing/credit-debits.ts`) right after it recomputes
`usage_rollups`, for the prior and current UTC month. Candidates are every live
org or user that holds a `credit_wallets` row — team org wallets are keyed by
org id and have no `users` row; personal orgs share that id with
`stable_user_id` and the sweep visits it once — plus every active gift/referral
overlay period that still lacks a wallet row. A missing wallet reads as zero
balance and is backfilled (`INSERT OR IGNORE`) before settle so the walk never
skips an overlay period (#2642). Per candidate and debit meter
(`creditDebitMeters`, open TEXT in D1 so CPU can join), billable units are usage
above the include; `credit_debit_progress` records units already handled. A
funded wallet is charged
`creditDebitCostMicroUsd(next) − creditDebitCostMicroUsd(accounted)`
($0.004 per unique worker day, $0.002 per million rows read, about 2× Cloudflare
list). Every other wallet advances progress without a charge (against at least
the purchasable Pro baseline when `creditWallet` is `none`), so a later top-up
or resubscribe never back-charges. The balance can dip below $0 by about an hour
of usage past the include; past-include usage stays stopped until a top-up
covers it. Debit ledger ids are deterministic per starting position, so an
overlapping run rolls back instead of charging twice. A new wallet, and a top-up
or admin grant that funds an empty wallet, advance progress to the billable
units already in the rollups for both months the lane settles (prior and
current), so credits never pay for usage from while the wallet was empty. The
sweep is bounded per run; `credit_debit_cursor` keeps its keyset position so
later runs reach every candidate. CPU, Durable Object duration, RunLog rows, and
email are not debited. Nobody is invoiced for overage. There is no
overage-invoice ledger.

**Top-ups.** `POST /account/credits/top-up.json` (Pro only) opens a one-off
Checkout Session (`mode=payment`, `price_data`, card saved with
`setup_future_usage=off_session`, metadata `kody_credit_top_up`). The
`/account/usage?topup=success` redirect and the `checkout.session.completed`
webhook both call `applyCreditTopUpFromCheckoutSession`, which credits Stripe's
`amount_total` after verifying the signed `client_reference_id`. The unique
`stripe_reference` makes replays no-ops. Packs are $10 / $25 /
$50 or a custom
$5–$500.

**Auto-refill.** Off by default. Turning it on requires a threshold of at least
$5, an amount, and a monthly cap at least that amount
(`validateCreditAutoRefillSettings`). After debits, `runCreditAutoRefill`
charges the saved card off-session when the balance is at or under the threshold
and the refill fits under this UTC month's cap (`decideCreditAutoRefill`). A
failed charge backs off 24 hours. The Stripe idempotency key is per user, month,
and refill number.

**Notices** (checkboxes in the usage page's Credits section, default on):
auto-refilled, hit the monthly cap (once per month), and balance at or below $5
(only while auto-refill is off, once per crossing).

**Admin grants.** `POST /admin/users/credits.json` (admin users page) and the
`adminCreditGrant` capability add house-funded credits to any account, including
the calling admin, without a Stripe charge. Each grant writes a ledger row with
`granted_by_user_id`, amount, recipient, time, and optional note, plus an admin
audit event. `adminCreditWalletGet` and `GET /admin/users/credits.json` read the
balance and recent ledger.

**Signup welcome credits.** Every newly created person account (password signup,
OAuth signup, admin-created) receives a one-shot house grant of
`signupWelcomeCreditCents` ($5) via `grantSignupWelcomeCredits` /
`maybeGrantSignupWelcomeCredits` in `signup-welcome-credits.ts`. The ledger row
is `admin_grant` with note `Welcome credits`, null `granted_by_user_id`, and
deterministic id `signup_welcome:{stableUserId}` so retries never double-grant.
The balance is held until the account is credit-eligible Pro (include → credits
→ stop); this is not a Free prepaid wallet product and does not unlock spend on
Free. The grant runs at account creation as best-effort: person-account inserts
set `orgs.signup_welcome_credits_pending = 1` in the same write, then clear it
after a confirmed grant. If D1 fails during the grant, signup still succeeds and
the flag stays set. Password / OAuth / passkey / 2FA login and `/account/usage`
wallet loads call `reconcileSignupWelcomeCreditsIfPending`, which retries only
when that flag is set. When Stripe later flips `stripe_credits_eligible` on,
`refreshStripePlanForUser` calls `forgiveCreditUsageBeforeUnlock` so Free-period
usage above the Pro include is not charged against the welcome balance.

**Admin eligibility.** To give an account the wallet without a Stripe checkout,
set its manual plan to `pro` (`adminUserUpdate`), fund it (`adminCreditGrant`),
and call `adminCreditEligibilitySet` with the target (`stableUserId`, `email`,
or `username`), `creditsEligible: true`, and an optional `note`. It writes an
admin audit event (target, new and previous value, note), never creates Stripe
customers or subscriptions. The steps work in either order: whichever write
(eligibility or the manual plan) unlocks the wallet first calls
`forgiveCreditUsageBeforeUnlock`, which advances debit progress to the unlocked
include before the write, so the unlock never charges for locked-period usage.
`creditsEligible: false` clears it; the balance stays on hold. Enforcement picks
the change up within the 60s entitlement cache.

## Compute rate limits

`execute_unique_workers_per_day`, `outbound_fetches_per_day`,
`job_runs_per_day`, and `automation_invocations_per_day` are daily-counter
resources (same mechanism as `email_sends_per_day`, consumed atomically with
`consumeDailyEntitlement`; execute uses `consumeExecuteUniqueWorkerDay`, which
spends a unit only for a worker not yet claimed that UTC day). Public
Free/Standard/Pro also apply a UTC-week hard cap on execute and outbound fetches
(Monday–Sunday, summed from the same UserMeter daily rows). Whichever window
hits first blocks. `max` and legacy Standard/Pro stay daily-only. They close the
metering → enforcement loop for the compute surfaces `usage-metering.md` already
observes:

- **Unique execute workers** (`execute_unique_workers_per_day`) count what
  Cloudflare bills: one unit per new Dynamic Worker (module graph) per org per
  UTC day. The MCP `execute` tool passes a capped claim
  (`packages/worker/src/mcp/execute-admission.ts`) into the executor, which
  awaits it once the worker id is minted and before `LOADER.get`.
  `UserMeter.claimDynamicWorkerDayWithinLimit` claims the `(day, workerId)` row
  and increments the counter in one transaction only when the id is new; repeats
  of code already loaded today (any params, success or failure) are free, and
  calls refused before load (rate brake, bundle errors, flag failures) never
  count. A denial leaves the worker unclaimed and propagates as a structured MCP
  `EntitlementLimitError`; a keyed call's idempotency key is released. Nested
  computed-import evaluations keep the uncapped attribution claim. The meter is
  keyed by the billing org (`ownerIdFromCaller`), like outbound fetches and
  jobs.
- **Execute runaway brake**: before any claim, bundle, or sandbox work, the tool
  calls `UserMeter.admitExecuteCall`, an in-memory per-org counter that refuses
  past the effective `execute_calls_per_minute` limit. The base is
  `executeCallsPerMinutePerSeat` (300) times live paid seats (minimum 300 for
  free or one-seat orgs), resolved through `resolveEntitlementLimit` so admin
  overrides raise it like other caps. It counts every call, including warm
  repeats the plan cap does not, and is a safety net rather than a billed quota
  (busiest production org-minute over the 30 days to 2026-10-10: 64 calls).
- **Execute usage in every response**: every signed-in hosted execute response
  carries `structuredContent.usage`: `unit` (unique execute workers) and `day`
  (plus `week` when the plan has a weekly window) with `used`, `limit`,
  `remaining`, and `resetsAt` (next UTC midnight / next UTC Monday). It comes
  from the worker claim when one ran (repeats included) and from a meter read
  for calls refused or failed before load, or for runs that crossed UTC
  midnight. It is best effort: when that meter read fails, the field is omitted
  and the call still returns.
- **Execute loop brake**: the same `admitExecuteCall` also refuses a connection
  that starts the identical call (same code or invoke target and same canonical
  params) more than `identicalExecuteCallsPerWindow` (20) times in a rolling
  `identicalExecuteCallWindowMs` (60s) window, with an "Execute loop detected"
  message that tells the agent it is looping. The repeat key
  (`executeRepeatKey`) hashes the request credential, acting user, the caller's
  `conversationId` when it sent one, the code or invoke target, and params. A
  status poll every 3 seconds stays under it; a back-to-back retry loop trips it
  within a minute. Refused calls are not recorded, so a looping agent gets at
  most 20 identical calls through per minute. In memory and bounded to 1,000
  keys per org, like the runaway brake.
- **Outbound fetches** are consumed at the top of `executeGatewayFetch`
  (`packages/worker/src/mcp/fetch-gateway.ts`), which every sandbox fetch passes
  through, before secret expansion. `FetchGatewayProps.email` carries the acting
  user's account email for plan lookup; when a caller cannot carry one (OpenAPI
  provider requests, package runtime), the gateway reverse-resolves the account
  via `findUserAccountByStableUserId` so the caller's real plan binds. Genuinely
  accountless synthetic contexts resolve to `free` so missing identity plumbing
  cannot grant elevated quotas. Server-side fetches of a user-supplied URL go
  through `executeGatewayFetch` (`packages/worker/src/mcp/fetch-gateway.ts`)
  rather than global `fetch`.
- **Job runs** are consumed at the top of `executeJobOnce`
  (`packages/worker/src/jobs/service.ts`) after caller-context resolution and
  before sandbox work, so over-limit ticks fail cheaply. This is separate from
  `scheduled_jobs` (how many job rows an account may own).
- **Automation invocations** are consumed in `runSavedPackageModuleOnce`
  (`packages/worker/src/package-invocations/module-execution.ts`) after artifact
  prep and before sandbox work for top-level always-on entrypoints: inbound
  webhooks, package subscriptions, and package-backed workflow steps. Nested
  invokes from MCP execute or package runtime do not consume again. This meter
  is a sibling of execute and jobs — webhook floods do not burn
  `execute_unique_workers_per_day`, and MCP execute does not burn
  `automation_invocations_per_day`. Public Free sits modestly above
  `job_runs_per_day`. Public Standard, Pro, and `max` are burst-friendly above
  job runs. Legacy Standard/Pro stay at the job-matched ceilings.
- **Job interval floor** (`planLimits.*.minJobIntervalMs`) applies to free and
  public Standard (15 minutes) and public Pro (5 minutes). `0` still means no
  extra floor (`max`, and legacy Standard/Pro). The floor is asserted on create
  and on an actual schedule change (`JobIntervalFloorError`). Identity-only
  refreshes of an existing faster job keep that schedule.

These consume only when the context has a `userId`, matching the usage-metering
rule that events without an owning user are skipped. Daily consumption is
authoritative in the per-user `UserMeter` Durable Object; see
[UserMeter](#usermeter).

## UserMeter

Daily rate-style resources (`email_sends_per_day`, `email_receives_per_day`,
`execute_unique_workers_per_day`, `outbound_fetches_per_day`,
`job_runs_per_day`, `automation_invocations_per_day`) are **authoritative in the
per-user `UserMeter` Durable Object** (`USER_METER` binding). Code lives in
`packages/worker/src/entitlements/user-meter-do.ts` and `user-meter-client.ts`;
storage layout and naming are documented in [Data storage](./data-storage.md).
UserMeter also stores first-seen Dynamic Worker ids per UTC day so usage
metering can record `dynamic_worker_day` without double-counting, and inbound
MCP OAuth last-used stamps so Account → Connections can show which host is safe
to revoke. `PlanLimits.maxUniqueWorkerDaysPerMonth` is the included allotment
(Free 50, purchasable Pro and retired Standard 350, retired Pro 2,000) shown on
`/pricing`. `PlanLimits.maxDurableObjectRowsReadPerMonth` is the included
Durable Object rows-read allotment (Free 0.5B, Pro and retired Standard 5B,
retired Pro 20B). Those two fields are the credit debit meters. They are not in
`entitlementResources`, so `assertWithinEntitlement` does not hard-cut them.
Hourly user warning emails cover approaching (80%) and reached (100%) includes
only when crossing the include would stop runs: an empty purchasable-Pro wallet
(`computeIncludeWarningPutsAccessAtRisk` in `universal/usage-presentation.ts`).
Free and other wallet-less plans never get those mails (the include never
charges or stops them), and funded wallets get the low-balance and auto-refill
cap mails instead. `/account/usage` (one page; `/account/credits` redirects to
its `#credits` section) uses the same framing from that module: activity (code
executions and runs) first, included compute as a bar capped at 100% with
past-include usage shown as dollars on credits, and one credits alarm only when
the wallet or access is at risk. Free sees Worker compute and Rows read as
informational counts only. Usage above an include debits a funded
purchasable-Pro wallet, stops new compute on an empty one, and is neither
charged nor stopped on plans without a wallet; see
[Prepaid credits](#prepaid-credits). Execute and outbound fetches are daily and
weekly caps; on purchasable Pro they are the include that credits extend.
Durable Object duration is observed (Cloudflare-measured GB-s plus the
StorageRunner RPC wall-clock proxy) and is not charged. See
[Usage metering](./usage-metering.md).

**D1 payload storage bytes** (`storage_bytes`) are **authoritative in
UserMeter**. `assertWithinStorageBytesEntitlement` uses atomic DO
`reserveStorageBytes` for all callers. Cold bootstrap lazily enqueues (and
awaits) an immediate per-owner physical seed via cold `initializeStorageBytes`
only (never CAS a live meter — that could wipe a reservation for bytes not yet
written). Scan failures fail closed. Usage reads share the same lazy enqueue and
also fail closed on scan errors. The bounded `d1_storage_reconciliation` lane
continues to correct drift via revision-guarded CAS, sweeping live owners by
keyset from the platform-owned `d1_storage_reconcile_cursor` row.

**Account-deletion write fencing:** D1 `users.deleting_at` remains the permanent
point gate. All callers (including email paths) supply `env`; UserMeter is
authoritative for all lease acquire/held/release/count operations. D1
`account_write_lease_repairs` is the repair audit log. See
[Account-deletion write fencing](#account-deletion-write-fencing).

StorageRunner and RepoSession `estimatedBytes` values and their per-bucket
inventory in `user_storage_buckets` stay a **separate** quota component.
StorageRunner write chokepoints pass `getCurrent` as a check-only composed total
(DO bytes from `readCurrentEntitlementResourceUsage(storage_bytes)` plus all
inventoried bucket estimates); that path does **not** reserve bytes in
UserMeter.

**Strong enforcement:** `consumeDailyEntitlement` and inbound
`consumeInboundDelivery` RPCs check the plan limit and increment inside the DO.
The Durable Object request model serializes mutations per user; counter updates
use optimistic concurrency on monotonic `revision` so concurrent consumes cannot
overshoot. Missing `(resource, day)` rows return `needs_bootstrap`; the service
then initializes that key at zero via `UserMeter.initialize()`
(`INSERT OR IGNORE`, concurrent-safe) before retrying. Warm enforcement awaits
only the DO RPC and never touches D1 daily counter state.

**Daily counter authority:** consume, refund, inbound charge/read, point-read
surfaces, retention, and account export/deletion use `UserMeter`; D1 has no
daily entitlement counter table or day index. `adminUserMeterParity` reports
meter-only daily counts (no D1 comparison fields exist). Analytics Engine
remains the production reporting path for email send/receive aggregates.

**Point-read surfaces** call `readDailyEntitlementResourceUsage` (UserMeter with
the same cold zero-init path). Account usage UI, `usageGet`, and Waiting
(`readEntitlementUsageSnapshot`) use one `UserMeter.readUsageSnapshot` RPC for
every daily counter, weekly window, and storage-bytes read the snapshot needs,
instead of one RPC per resource:

- Account usage UI — `packages/worker/src/app/account-usage-data.ts`
- Account email usage panel — `packages/worker/src/app/account-email-data.ts`
- `usageGet` MCP capability — plan, limits, and usage of the connection's bound
  org (`ownerIdFromCaller`), the same org execute and package-cap checks enforce
  against. A team-bound connection reports the team plan, not the caller's
  personal org.
- `usageTrendGet` MCP / Open API capability (`GET /v1/account/usage/trend`) —
  bound-org daily UserMeter series (`readDailyTrend`) plus a cheap
  `usage_rollups` monthly series for hosted execute and unique Worker days
- `usageByPackageGet` MCP / Open API capability
  (`GET /v1/account/usage/by-package`) — bound-org current-UTC-month
  past-include credit attribution by package (`loadCreditAttributionBreakdown` /
  account usage `whereItWent`). Meters are Worker compute and Rows read credits
  only; optional `packageId` returns that package’s slice. Does not add a
  package axis to UserMeter.
- Admin per-user usage drill-down —
  `packages/worker/src/admin/user-usage-data.ts` (via
  `readAdminEntitlementConsumption` in
  `packages/worker/src/admin/entitlement-consumption.ts`, including
  `storage_bytes` from UserMeter)
- Admin fleet entitlement-pressure panel and `usage_entitlement_alert` lane —
  same `readAdminEntitlementConsumption` helper over a bounded sweep of the top
  ~15 active users by current-month event count. The sweep resolves each
  account's **effective** plan (manual grant, Stripe, and unexpired second-agent
  / referral Pro overlays) via `resolveUserEntitlementFromRow`, and selects
  `orgs.entitlement_ladder` so legacy Standard/Pro is scored against
  `legacyPlanLimits` (the same table enforcement uses). Gifted Pro therefore
  does not page Free-cap crossings while the overlay is active, except
  `email_receives_per_day`, which inbound mail still enforces against the base
  plan — the sweep scores that one resource via `resolveBaseUserEntitlement`.
  The lane emits one `fleet.entitlement.crossed` event per 80% or 100% crossing
  (and per first over-threshold runtime-duration month, unique Dynamic Worker
  cost month, or three-of-seven execute-cap train) to admin-owned packages.
  Staying over the same threshold does not emit again; dropping below and
  climbing back is a new instance. KV prefix `fleet-entitlement-crossing:v1`
  stores `{prefix}:{userId}:entitlement:{threshold}:{resource}` for stock
  limits, appends the UTC day for `*_per_day` counters, uses
  `{prefix}:{userId}:runtime_duration:{month}` for the 24h runtime signal,
  `{prefix}:{userId}:dynamic_worker_cost:{month}` for the unique-worker cost
  signal, and `{prefix}:{userId}:repeated_entitlement:{resource}` for the
  execute-cap train. Hit days live under `fleet-entitlement-hit:v1`.
- User entitlement warning emails (same hourly lane) — emails verified person
  accounts when usage crosses 80% or 100% of their effective plan (transactional
  template). Throttle is one mail per crossing of a given percentage on a
  specific entitlement: staying at 10/10 packages does not mail again the next
  UTC day. Dropping below that threshold and climbing back over it is a new
  instance. Same-hour crossings of the same kind batch into one mail. KV prefix
  `entitlement-warning-user:v3` stores `{prefix}:{userId}:{kind}:{resource}` for
  stock limits, and appends the UTC day for `*_per_day` counters so a midnight
  reset is a new instance. Stock claims use a 30-day TTL that the hourly sweep
  refreshes while the user is over, so sitting at a cap stays silent and a later
  drop out of the candidate set can rematch after the claim expires. Daily
  claims keep a 36-hour TTL. Claim reads also honor same-day `v2` daily keys
  (one claim for every resource in that kind's bucket). A `v2` key from a prior
  UTC day claims stock limits only, so a `*_per_day` midnight reset can mail.
  Candidate selection is the top ~80 accounts by current-month event count plus
  high package/secret stock, capped at 100. The hosted execute cap does not wait
  for the sweep: the worker claim that lands exactly on 80% or 100% of the daily
  limit (`executeDailyWarningCrossing`) calls `sendEntitlementWarningNow` in
  `waitUntil`, which mails the org's billing recipients and writes the same
  instance claim, so the sweep skips it (and the immediate send skips a crossing
  the sweep already mailed). Operator crossing events run even when user warning
  sends fail. The same hourly lane also evaluates the usage-state campaign.
  Users near stock caps enter `LimitAware` and stay campaign-silent so these
  entitlement warnings remain the entitlement nudge. See
  [Usage metering](./usage-metering.md#usage-campaign).

`readEntitlementResourceUsage` counts only APP_DB-backed row resources (`repos`,
`saved_packages`, `secrets`). Resources whose authority is elsewhere
(`scheduled_jobs` via `jobsData`, `repo_sessions` via `RepoSessionIndex`, daily
counters via UserMeter, `stored_email_messages` via Mailbox,
`concurrent_workflows` via RunLog, `storage_bytes` via UserMeter, and
`email_message_bytes` via caller `getCurrent`) throw from that helper and must
use `readCurrentEntitlementResourceUsage` or an explicit `getCurrent` callback.

**Inbound retry idempotency:** inbound receive quota uses
`UserMeter.consumeInboundDelivery`, which atomically claims `delivery_id` and
consumes one `email_receives_per_day` unit inside a SQLite transaction. Retries
return the accepted counter without incrementing (`replayed: true`).
Cross-UTC-day retries use the original claim's resource/day.

### D1 payload storage bytes — UserMeter authority

**Authority:** the UserMeter `storage_bytes_state` singleton is the sole
enforcement and usage counter. The reconcile lane walks every live owner —
personal orgs (`users.stable_user_id`) and team orgs (`orgs.id`, no `users` row)
— by one keyset from the platform-owned `d1_storage_reconcile_cursor` singleton
(advanced once per processed page, wrapping at the tail). Cold bootstrap seeds
from physical D1 bytes via an immediate per-owner reconcile
(`enqueueOwnerD1StorageReconcile`); the lane remains the backstop for drift.

**Reserve path (`assertWithinStorageBytesEntitlement`):**

1. Resolve plan limit from `getCachedUserPlan` (60s TTL OK — only limit
   resolution is cached; DO counter is always fresh).
2. Call `UserMeter.reserveStorageBytes({ requested, limit })`.
3. If `needs_bootstrap`: probe for a live owning org (`users` or `orgs` row). If
   missing (synthetic context / non-account id), apply free-plan allow/deny
   without touching the DO — missing owners never create a DO singleton. If the
   owner exists, lazily enqueue and await `enqueueOwnerD1StorageReconcile`
   (deduped per owner so concurrent cold reserves share one physical SUM;
   failures propagate), then retry (max 2 attempts). Do not zero-init after a
   failed scan.
4. On `!reserved`: throw `EntitlementLimitError`.
5. `env.USER_METER` is required on the DO-reserve path; throws immediately if
   absent (fail closed). The StorageRunner check-only path (bucket totals via
   `getCurrent`) omits `env` safely.

**Usage reads (`readCurrentEntitlementResourceUsage(storage_bytes)`):** Reads
from UserMeter; cold bootstrap seeds from the physical D1 sum via
`reconcileUserD1StorageBytes` so usage pages are not stuck at 0 until the keyset
sweep wraps. Scan failures fail closed (no inaccurate zero materialized). The
generic D1 `readEntitlementResourceUsage` for `storage_bytes` throws with
guidance — callers must use `readCurrentEntitlementResourceUsage` or
`assertWithinStorageBytesEntitlement`. StorageRunner's composed baseline also
reads UserMeter via `readStorageBytesFromUserMeter`.

**Account export and purge:** `UserMeter.exportCounters` returns authoritative
`storageBytesState`, sanitized `deletionState`, and `inboundConnectionLastUsed`
on the first page only (`startAfter` absent). Subsequent pages return `null` for
each so paged consumers never double-count them. `UserMeter.purge()` clears
counters, inbound delivery claims, storage state, write leases, and inbound MCP
last-used rows via `deleteAll`, then restores an existing deletion tombstone so
in-flight cleanup stays fenced. After the D1 `users` row is deleted, origin
calls `clearUserMeterDeletionTombstone` so the purged object keeps no state. If
that clear fails, a live D1 row that collides with a leftover DO tombstone
clears it on the next `withAccountWriteLease` acquire.

### Account-deletion write fencing

UserMeter schema **v8** stores `account_write_leases` with `token`, `holder`,
`acquired_at`, and `pending_repair_id`.

**Authority:** D1 `users.deleting_at` remains the **permanent point gate** (auth
projection / purge failures fail closed). All callers supply `env`; UserMeter is
authoritative for lease acquire / held / release / count via `acquireWriteLease`
/ `assertWriteLeaseHeld` / `releaseWriteLease` / `countActiveWriteLeases`.
Missing `USER_METER` binding **fails closed**. D1 `account_write_lease_repairs`
is the audit log for repairs. ALS nested-lease reuse propagates per
`stableUserId` across the async call chain. MCP `/mcp` takes the full UserMeter
write lease only for mutating JSON-RPC (`tools/call` other than `search`,
batches that include a write, and unclassified bodies); read-only methods
(`initialize`, `tools/list`, `ping`, and `search`) check D1 `users.deleting_at`
only so a deleting account still gets `409 account_deleting` without the acquire
/ held / release RPCs.

**`markAccountDeleting`:** `COALESCE`s D1 `deleting_at` (idempotent), then calls
`markDeleting` on the DO (sets/preserves the tombstone). Returns the active DO
lease count for drain waits. If the DO call fails and D1 did not already have a
tombstone, the D1 fence is rolled back.

**`abortAccountDeleting`:** used when deletion fails before cleanup (active
writes or incomplete inventory) **and this invocation created the fence**.
Automatic abort passes `expectedDeletingAt` so D1 and
`UserMeter.clearDeleting()` only drop a matching tombstone. Cleanup failures and
retries against an already-fenced account keep the tombstone so a retry can
finish. Operators restore a leftover fence with `adminAccountDeletionAbort`
(stable user id + audit reason), which resolves `users.id` internally.

**Admin list / repair:** `listActiveAccountWriteLeases(env, userId)` reads DO
leases via `listWriteLeases` pages — no D1 union. Repair is DO-only and
audit-first: prepare (stable `repairId`, lease stays held) → insert/verify D1
audit row → finalize exact pending DO repair. Finalize failure leaves DO held
and fails closed; retry resumes from the existing audit row. Retry after a lost
finalize response returns success when the matching audit exists and the DO
lease is absent. Wrong user, stale `acquiredAt`, or short reason requests fail
closed.

**Account export / purge:** first-page sanitized `deletionState` omits raw
token/holder (count and `acquiredAt` only). `purge()` clears leases and counters
via `deleteAll` then restores any deleting tombstone while the D1 user row still
exists. After that row is deleted, origin drops the restored tombstone so the
purged object keeps no state. Live D1 plus a leftover meter tombstone heals on
the next write-lease acquire (D1 is re-checked before the clear so an
in-progress deletion keeps its fence, and again after the clear so a deletion
that started in that window restores the tombstone and fails closed). D1
`deleting_at` remains the gate. Post-write held checks treat pending repair as
held until finalize, then surface `AccountWriteLeaseLostError`.

**Current UserMeter authority:** all write leases (including email) and storage
bytes are authoritative in UserMeter. See the storage and write-fencing sections
above.

**Daily-counter authority:** UserMeter is the only daily-counter store. Admin
parity reports meter-only daily counts; Analytics Engine remains the reporting
store.

### Admin UserMeter parity gates (`adminUserMeterParity`)

Production verification uses the admin-only read-only capability
`adminUserMeterParity` (input: `stable_user_id`). It compares physical D1
payload bytes and the permanent D1 deletion tombstone with direct UserMeter
RPCs. It never writes parity state. The daily section is meter-only. Opening a
cold UserMeter stub may still run Durable Object constructor schema maintenance
and opportunistic stale daily-counter pruning. Cold meter rows surface as
`needsBootstrap` with `meterCount`/`meterBytes` null.

Interpret the structured report as independent gates:

| Gate                     | Pass condition                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily counters (UTC day) | Meter-only reads: each daily resource reports `meterCount` (null with `needsBootstrap: true` on cold accounts).                                                               |
| Storage bytes            | `storage.parity` — physical D1 payload recompute (`calculateUserD1StorageBytes`) equals UserMeter `readStorageBytes` and the meter does not need bootstrap.                   |
| Deletion tombstone       | `deletion.deletingAtParity` — D1 `users.deleting_at` matches the meter tombstone.                                                                                             |
| Active lease count       | `deletion.activeLeaseCount` — count of authoritative UserMeter write leases. Alert on unexplained non-zero counts after known writer processes have been verified terminated. |

Treat unexplained storage or deletion mismatches as failures. Expected cold
accounts may report `needsBootstrap` until live traffic seeds the DO; that is a
bootstrap gap, not a silent pass.

### Storage reconciliation (`adminUserMeterStorageReconcile`)

The admin-only maintenance capability `adminUserMeterStorageReconcile` is a
**corrective physical-storage reconciliation** tool under UserMeter authority.
Each invocation:

1. Scans one keyset page (default and max `batch_size` 8) of users ordered by
   `stable_user_id`, starting after the platform-owned
   `d1_storage_reconcile_cursor` position and wrapping at the tail.
2. For each user: reads the current UserMeter revision **before** computing the
   physical byte count (`capturedRevision`).
3. Recomputes the absolute byte count from D1 payload tables via
   `calculateUserD1StorageBytes` (the physical source).
4. Applies the result via a **revision-guarded CAS** (`reconcileStorageBytes`):
   only writes if `capturedRevision` still matches the current DO revision. This
   prevents the sweep from clobbering a live reservation that arrived between
   step 2 and the CAS call.
5. Advances the keyset cursor past the processed page; no byte values are
   written to D1.

**Result codes:**

- `updated` — CAS applied (or cold init succeeded); UserMeter updated.
- `deferred` — CAS miss (a concurrent reserve bumped the revision) or cold-init
  race (another caller created the singleton first). The row is rotated to the
  back of the oldest-first queue for the next sweep. **A deferred row is not a
  failure.** The sweep continues; it will be retried on the next invocation once
  the meter is quiescent.
- `failed` — unexpected error; retried on the next sweep wrap.

**CAS miss behavior:** when a live `reserveStorageBytes` call bumps the revision
between revision capture and the CAS attempt, `reconcileStorageBytes` returns
`applied: false`. The reconcile function immediately defers — it does not retry.
The reservation byte count is fully preserved.

**Cold init race:** when the DO singleton is absent at read time
(`needs_bootstrap`), the reconcile computes the physical sum and calls
`initializeStorageBytes` (INSERT OR IGNORE). If `created: false`, another
concurrent caller already created the singleton; reconcile defers to the next
sweep without overwriting that caller's state.

Use to correct drift from deletes, failed writes, or any discrepancy between DO
counter and physical payload tables. Safe to repeat as a corrective or catch-up
sweep; not idempotent with live writes.

Module wiring: `consumeDailyEntitlement`, `refundDailyEntitlement`, and
`readDailyEntitlementResourceUsage` require `env.USER_METER` and fail closed
when the binding is missing. Storage-byte helpers
(`assertWithinStorageBytesEntitlement`, `reconcileUserD1StorageBytes`,
`readCurrentEntitlementResourceUsage` for `storage_bytes`) require `USER_METER`;
missing binding fails closed for reserve and read paths.
`calculateUserD1StorageBytes` is the physical payload recompute used by the
reconcile lane, cold-drift correction, and the parity report.

## Schema history

The pre-squash plan-column evolution (NULL rows → `'unlimited'` backfill → NOT
NULL → `'unlimited'` renamed to `'max'` → DEFAULT `'free'` → CHECK constraints)
is collapsed into the squashed baseline; the individual migration files live in
Git history only. `0002-restructure-plan-tiers.sql` renames stored `pro` to
`standard` and `partner` to `pro` (plan and Stripe plan columns, and the
since-dropped `invites.plan`) and rebuilds both CHECK constraints for `free`,
`standard`, `pro`, and `max`. `0043-users-entitlement-ladder.sql` introduced the
entitlement ladder (`public` | `legacy`, default `public`; stored on `orgs`) and
backfilled `legacy` for then-active Stripe Standard/Pro subscribers and manual
Pro grants. `0044-users-stripe-price-id.sql` introduced `stripe_price_id`
(stored on `orgs`) for the granting Stripe price so a later refresh can drop
`legacy` on a subscription change.

## Assigning plans

New accounts start with `orgs.plan = 'free'`. Password and social signup write
that default via `resolvePlanWrite`. Admin-created accounts and seed SQL follow
the same `resolvePlanWrite` default. Admins assign or reset plans on existing
users from `/admin/users` (validated with strict `parsePlanName`).

Admins also assign or reset plans on existing users through two audited,
admin-only surfaces, both backed by `updateAdminUserPlan` in
`packages/worker/src/admin/users-data.ts`:

- **Admin UI** — the "Manage plan" panel on `/admin/users` posts
  `{ action: 'update_plan', userId, plan }` to `POST /admin/users.json` (guarded
  by `update:user:any`). `plan: null` maps to `free` (writers never persist
  NULL); unknown plan strings are rejected with `400` rather than coerced.
- **MCP** — the `adminUserUpdate` capability (`requiredRole: 'admin'`) updates
  one user by `id` or `email` and accepts `plan: PlanName | null` (null maps to
  `free`).

Both paths validate against the plan registry (`parsePlanName` / `planNames`)
and write an `admin`-category audit event with reason `target_user_id=…;plan=…`.
Daily counters accumulate for every user regardless of plan, so assigning a
recognized plan later binds immediately against the usage already counted that
day.

Paid upgrades via Stripe write `orgs.stripe_plan` (not `orgs.plan`); see
[Billing](#billing). Effective entitlement uses the higher-ranked of the two
when a manual plan is set.

## Admin limit overrides

Admins can raise any daily, weekly, or monthly cap for one org without changing
its plan. Nothing in code names an org; overrides are data.

**Keys** (`limitOverrideKeys` in `plans.ts`): `execute_unique_workers_per_day`,
`execute_unique_workers_per_week`, `outbound_fetches_per_day`,
`outbound_fetches_per_week`, `job_runs_per_day`,
`automation_invocations_per_day`, `email_sends_per_day`,
`email_receives_per_day`, `unique_worker_days_per_month`,
`durable_object_rows_read_per_month`, and `execute_calls_per_minute`. Each
override is a whole number or `'unlimited'` (`unlimitedLimit`,
`Number.MAX_SAFE_INTEGER`), an optional `expires_at`, a required reason, and the
admin who set it.

**Storage:** D1 `org_limit_overrides` (`0103-org-limit-overrides.sql`), primary
key `(org_id, limit_key)`, `limit_value` NULL for unlimited. It is the only
source of truth. Expired rows stay for history and are ignored by reads
(`expires_at > now` in SQL and again in `applyLimitOverrides`).

**One resolution path:** `getUserEntitlement` loads active overrides into
`UserEntitlement.limitOverrides`. `resolveEntitlementLimits(entitlement)`
computes the plan limits (ladder, wallet, seat pool, credits ceiling) and then
applies overrides on top with `applyLimitOverrides`. Every enforcement and
display path that has an entitlement resolves through `resolveEntitlementLimit`
/ `resolveWeeklyEntitlementLimit`; the `resolvePlan*` helpers only answer "what
does this plan give" (admin comparisons, credits marketing, billing includes).

- An override only raises. The enforced value is `max(plan limit, override)`, so
  a later plan upgrade past the override still wins and an override can never
  lower a cap.
- A weekly key does nothing where the plan has no weekly window (legacy ladders,
  `max`); overrides never add a window.
- The fail-closed public Free fallback (unknown org, mismatched email/stable-id
  pair) never carries overrides.

**Cache and freshness:** the 60-second per-isolate entitlement cache cannot be
invalidated across isolates. The write path drops the writing isolate's entries
(`invalidateCachedUserEntitlement`), and every counted check for an overridable
resource (`assertWithinEntitlement`, `consumeDailyEntitlement`,
`consumeExecuteUniqueWorkerDay`, and the $0 compute stop) reads the org's
overrides live from D1 in parallel with the cached entitlement. So a change
binds on the next counted check everywhere, with no TTL that can hide it.

**Admin surfaces** (all `requiredRole: 'admin'`):

- `adminOrgLimitsGet` — plan, effective limit, and override per key for one org,
  addressed by `orgId` or `org` handle (`@kody` or `kody`).
- `adminOrgLimitOverridesSet` — set, change, or remove (`value: null`) any
  number of keys with one reason. Unchanged keys are skipped.
- `GET` / `POST /admin/orgs/limits.json` and the "Limit overrides" panel on
  `/admin/users` (personal orgs).

Every set, change, or remove writes an org audit event (`limit_override.set` /
`.changed` / `.removed`, `resource_type` `limit_override`, `resource_id` the
key) with the acting admin, `previous` and `next` (`value`, `expiresAt`,
`reason`, `setByUserId`), and the reason.

**What users see:** the usage page, email usage, admin consumption views, and
execute `entitlement` metadata (`limit`, `remaining`) report the effective
limit. `'unlimited'` displays as "Unlimited". Nothing user-facing mentions that
an override exists.

Overrides change caps, never prices:

- **Daily and weekly keys** raise the rate cap only. A purchasable-Pro org with
  `creditWallet: 'empty'` is still stopped past a monthly compute include
  (`ComputeOverageLimitError`) even when its daily cap is raised; raising
  `job_runs_per_day` does not let a $0 wallet spend past the include.
- **Monthly keys** (`unique_worker_days_per_month`,
  `durable_object_rows_read_per_month`) move only the $0 stop threshold in
  `resolvePastIncludeStop`. Debits still use the plan include
  (`computeMonthlyOverage`), so:
  - With a funded wallet, every unit past the plan include is debited exactly as
    without an override.
  - With an empty wallet, usage between the plan include and the override runs
    without the stop. The debit sweep never charges an empty wallet: it advances
    progress, and a later top-up does not charge that stretch (the existing
    "stopped then resumed" forgiveness). Set a monthly override only for orgs
    that should run past the include at $0.
  - For an empty wallet, the usage page include, the credits alarm, and the
    entitlement-warning emails all compare against the same stop threshold
    (`resolvePastIncludeStopLimits`), so none of them reports runs as stopped
    while the override still admits them.

## Plan lookup

The MCP `userId` is the account's stored `users.stable_user_id` (NOT NULL,
unique index; minted randomly at signup by `mintPersonId`, then preserved across
email changes). `getUserEntitlement` returns `{ plan, ladder }`.
`getUserPlan(db, { userId, email })` is the plan-only wrapper and always returns
a `PlanName`:

1. Returns `free` when `userId` is absent (no warn).
2. Returns `free` without touching D1 when `userId` is not a 64-char hex string
   (test fixtures and non-account ids).
3. When email is present: reads `plan`, `stripe_plan`, `entitlement_ladder`, and
   the two Pro-overlay expiry columns (`second_agent_standard_gift_expires_at`
   and `referral_standard_credit_expires_at`) where
   `email = ? AND stable_user_id = ?`, then returns
   `resolveEffectivePlanWithSecondAgentGift` with `laterIsoTimestamp` of those
   expiries. A mismatched email/stable-id pair or missing row returns `free` (no
   warn).
4. When email is absent/blank: reverse-resolves the same columns by
   `stable_user_id` so package-job, workflow, webhook, and other background
   contexts that persist `email: ''` still enforce the account's real plan.
   Missing rows return `free`.

Interactive surfaces still carry email (app sessions expose
`user.mcpUser.email`, MCP caller contexts expose
`ctx.callerContext.user.email`). Background package-runtime paths that only have
the stable userId do not need a separate email hydrate step for entitlement
checks — `getUserPlan` reverse-resolves for them.

Package-owned scheduled jobs also refresh their persisted caller identity and
published commit on every package sync, including when schedule, timezone, and
enabled state are unchanged. Execution rehydrates the account user from the job
row's stable user ID before exposing storage or nested MCP capabilities. The
stable-ID plan lookup is the fallback when a saved caller context has no email.

Inbound email routing has no caller context and resolves the owning account via
the indexed username lookup (`findPublicUserIdentityByUsername`) — it does not
use stable-id reverse resolution. `findUserAccountByStableUserId` in
`service.ts` remains available for other contextless paths that need email /
verified-state (for example the outbound fetch gateway), mirroring
`findUserAccount` in `email/platform-address.ts`.

**Enforcement plan cache:** `assertWithinEntitlement` resolves the plan limit
via `getCachedUserEntitlement`, which wraps `getUserEntitlement` behind a
60-second per-isolate TTL cache keyed by D1 binding and
`(stable_user_id, normalized email)`. Cache entries share the lookup semantics
above; failures are never cached. Built-in usage counters and any `getCurrent`
override are read fresh on every call, so only the plan limit can be stale — a
plan or ladder change may take up to ~60s to bind at enforcement points while
current usage stays accurate. Surfaces that display the user's plan (billing UI,
email usage) should keep calling `getUserPlan` / `getUserEntitlement` directly.

## The error shape

Every enforcement point throws `EntitlementLimitError` from
`entitlements/errors.ts` and lets it propagate unchanged. Its `details` field is
the stable programmatic contract:

```ts
{
	code: 'entitlement_limit_exceeded',
	resource: EntitlementResource, // e.g. 'scheduled_jobs'
	plan: PlanName,                // always a known plan name (including `max`)
	limit: number,
	current: number,
	upgradeHint: string,
}
```

The `message` is built by `buildEntitlementLimitMessage` and is the single
user-facing string across MCP and UI surfaces. For rate/compute limits credits
extend (`creditsUnlockedResources`), `entitlementCreditsOffer` picks the next
step: purchasable Pro at $0 adds credits to keep going past the include; a
funded wallet (at the credits ceiling) and `max` get reduce-only guidance; Free
gets the Pro upgrade; retired and gift/referral Pro learn that Pro with credits
runs past its include (they must subscribe before buying). Other resources
include a self-serve billing offer only when `hasHigherPublicPlan(plan)` is true
(Free). Purchasable Pro stock is Max on the subscription base table (not
credit-extended), so stock denials are reduce-only there. The job interval floor
hint is always reduce-only (Free and Pro share 15 minutes).

The hint also follows the resource's window in `entitlementResourceWindows`
(`universal/plans.ts`), the one list of how each resource counts. `utc_day`
meters say they reset at 00:00 UTC and how long that is from now (weekly
execute/outbound denials say Monday 00:00 UTC). Only `standing` counts get
"remove or finish existing", and `per_item` caps say to use fewer per request.
`dailyEntitlementResources` is derived from that map.

Rate limit example (purchasable Pro with $0):

> Plan limit reached: your "pro" plan allows at most 500 unique execute workers
> per day and you currently have 500. This daily limit resets at 00:00 UTC, in
> 1h 26m. Rerun code you already ran today and vary params; repeats are free, or
> add credits at /account/usage#credits to keep going past your include.

Daily outbound fetch example (purchasable Pro with a funded wallet at the
ceiling):

> Plan limit reached: your "pro" plan allows at most 750000 outbound fetches per
> day and you currently have 750000. This daily limit resets at 00:00 UTC, in 1h
> 26m.

Monthly include stop (purchasable Pro with $0, `ComputeOverageLimitError`):

> Worker compute include used up: your "pro" plan includes 350 worker-compute
> days this UTC month and you have used 412. With no credits left, usage past
> the include stops. Add credits at /account/usage#credits to keep going; usage
> past the include is charged at $0.004 per worker-compute day. Keep package
> code stable so the same worker stays warm. …

Customer copy never says a balance "unlocks" or "lifts" limits and never names
Max; SSR and unit tests forbid that wording on pricing, billing, credits, and
usage surfaces.

Stock limit example (purchasable Pro):

> Plan limit reached: your "pro" plan allows at most 5000 scheduled jobs and you
> currently have 5000. Remove or finish existing scheduled jobs you no longer
> need.

Rules:

- `details.plan` is always a known plan name; denial messages always quote that
  plan name.
- `details.upgradeHint` comes from `buildEntitlementUpgradeHint`. Do not append
  a billing or credits CTA at the enforcement point.
- Never compose a custom denial message at an enforcement point; change the
  builder if the message needs work.
- Never catch and rewrap `EntitlementLimitError` (use `isEntitlementLimitError`
  if a surface must detect it). MCP execute results and UI handlers serialize
  `error.message`, so the message carries the full context even across Durable
  Object / RPC boundaries.
- MCP `search` / `execute` tool errors that are entitlement or plan-limit
  denials also attach a focused `structuredContent.entitlement` object built
  from those same `details` (plus compact `used` / `remaining` on daily quota
  resources). Ordinary successful tool returns omit `entitlement`. The object
  never includes secrets, raw billing records, prices, or unrelated
  entitlements. See `packages/worker/src/mcp/entitlement-metadata.ts`.

## Counting strategy

- **Row-count limits** (saved packages, scheduled jobs, repo sessions, secrets)
  are counted via helpers in `service.ts`. APP_DB resources (saved packages,
  secrets) use built-in D1 counters. **Scheduled jobs** count through
  `jobsData(…).countJobsForUser` on the jobs worker (pass `getCurrent` into
  `assertWithinEntitlement`; there is no APP_DB built-in counter). **Repo
  sessions** count `status = 'active'` rows in the per-user `RepoSessionIndex`
  catalog. Unused (never-checkpointed) leftovers are swept after 30 minutes
  idle; checkpointed sessions after 7 days idle (`repo_session_cleanup` lane,
  100 rows per 5-minute tick). **Concurrent workflows** are authoritative in
  per-user RunLog `workflow_projections`: create reserves atomically via
  `reserveWorkflowProjectionSlot`, and usage readers call
  `countActiveWorkflowProjections` through
  `readCurrentEntitlementResourceUsage`. D1 has no `workflow_runs` table. See
  [Run records](./run-records.md).
- **Rate-style limits** (email sends/receives per day, unique execute workers
  per day, outbound fetches per day, job runs per day) are **authoritative in
  the per-user UserMeter Durable Object** (UTC day keys). Call
  `consumeDailyEntitlement` on every attempt: it resolves the plan limit,
  atomically checks and increments inside the DO, and throws
  `EntitlementLimitError` when over limit. Unique execute workers are the
  exception: `consumeExecuteUniqueWorkerDay` runs at the load gate once the
  worker id is known, and spends only for a new worker that UTC day, so repeats
  and calls refused earlier (rate brake, parse errors) never count. Public
  Free/Standard/Pro execute and outbound also check a UTC-week sum of those same
  daily rows; whichever window hits first blocks. Every resolved plan has a
  finite numeric limit. Counting attempts rather than successes keeps the limit
  abuse-resistant for permanent rejects (parse failures, entitlement/quota
  rejects).

  **Cold bootstrap:** missing `(resource, day)` rows trigger
  `UserMeter.initialize({ count: 0 })` (`INSERT OR IGNORE`) before retrying the
  consume. Concurrent cold callers cannot double-apply a non-zero baseline.

  **Daily counter authority:** consume/refund/inbound charge/read paths use
  `UserMeter`; D1 has no daily entitlement counter table.

  A delivery claim remains charged when later storage fails. Cloudflare Email
  Routing retries replay that same `delivery_id` through
  `UserMeter.consumeInboundDelivery` without incrementing again, including
  across a UTC-day boundary. The retained claim is the idempotency boundary;
  production inbound handling does not call `refundDailyEntitlement`.

- **Per-unit size limits** (`email_message_bytes`) compare one candidate value
  against the limit instead of an accumulating count: the enforcement point
  passes the candidate size via `getCurrent` with `requested: 0`. There is no
  built-in counter for these.
- **Storage-byte limits** (`storage_bytes`) split into two quota components:
  1. **D1 payload bytes (authoritative in UserMeter):** user-owned D1 rows with
     durable payloads (`email_messages.raw_size` plus extracted message
     bodies/metadata, externally stored attachments, values, encrypted secrets,
     memories, saved-package projections, jobs, repo/session metadata, package
     invocation results, and published artifact metadata). Run records in the
     per-user `RunLog` Durable Object are intentionally **excluded** — they are
     observability history, not user content. Write chokepoints atomically
     reserve positive byte deltas via `assertWithinStorageBytesEntitlement`
     against the UserMeter DO (every caller, including email). Cold DO
     singletons seed from the physical D1 sum via a lazy per-owner reconcile
     enqueue (scan failures fail closed) before retrying the reserve. The
     bounded `d1_storage_reconciliation` lane recomputes the physical
     cross-surface sum via `calculateUserD1StorageBytes` and applies it to
     UserMeter via a revision-guarded CAS (never clobbers a live reservation);
     no byte values are written back to D1 — see [UserMeter](#usermeter).

  2. **Durable Object bucket estimates (separate):** StorageRunner buckets and
     RepoSession workspaces expose `estimatedBytes`. RepoSession sums SQLite
     `databaseSize` with `REPO_SESSION_BLOBS` prefix bytes. Inventory rows
     distinguish them by `kind` and persist the latest measurement on
     `user_storage_buckets.estimated_bytes`. Repo sessions register on open,
     refresh after workspace mutations, and remove their rows on
     discard/purge/session or source cleanup. Write chokepoints that pass
     `getCurrent` compose
     `UserMeter payload bytes (readStorageBytesFromUserMeter) + sum of per-bucket estimates`
     for a **check-only** entitlement comparison — `getCurrent` never reserves.
     Only the bucket that triggers the baseline read (plus any inventoried
     bucket with no stored estimate yet) is probed live; every other bucket
     contributes its stored D1 estimate, so mutating writes do not fan
     `getEstimatedBytes` RPCs across the whole inventory. Live probe results are
     persisted fire-and-forget with **UPDATE-only** statements (they can never
     recreate an inventory row removed by account, package, or job deletion),
     and mutating StorageRunner and RepoSession RPCs opportunistically refresh
     their own bucket's stored estimate after the write, throttled per bucket
     per isolate (`storageBucketEstimateRefreshMinIntervalMs`). Stored estimates
     are freshness hints with bounded lag — acceptable for an order-of-magnitude
     cap because the bucket paying the baseline read is measured live and the
     run cache accounts for the run's own accepted writes. `requested` is the
     candidate payload size when known. Pure read-only `storage.sql` /
     `packageStorage().sql` statements (`SELECT` / `EXPLAIN` / schema `PRAGMA`)
     skip the baseline read entirely even when the helper marks the call
     writable. Mutating SQL and `storage.set` in one sandbox share a per-run
     baseline cache so repeated writes do not re-read the baseline; a later
     write in the same run that targets a **different** already-inventoried
     bucket reuses that bucket's stored estimate rather than probing it live
     (bounded staleness, same trade-off as peers). Each live estimate read waits
     at most ~2s via `Promise.race` and is retried with backoff
     (`storageEstimateReadRetryDelaysMs`; a single 150ms retry lost to transient
     per-bucket DO read _rejections_ in production) before failing closed for
     the caller. The underlying DO RPC is not cancelled if the runtime keeps it
     running, so a timeout does **not** open a second stub call to the same
     `storageId` — retries keep waiting on the in-flight promise. Fast rejects
     still start a new RPC after backoff. A scheduled job that still fails
     closed treats this as a transient occurrence error: the claimed run stays
     `running` so the scheduler can abandon it and retry the same `scheduledFor`
     instead of finishing a terminal error that idempotency would replay. A cron
     lane (`storage_bucket_estimate_backfill`,
     `packages/worker/src/storage-buckets/estimate-backfill.ts`) sweeps
     inventory rows without a stored estimate in bounded batches (failed probes
     stay unmeasured and are retried on later sweeps) so freshly migrated
     inventories converge to stored estimates within a few ticks instead of
     making each user's first mutating write pay (and possibly fail on) the
     whole-inventory probe. The D1 payload counter intentionally does **not**
     attempt to scan Cloudflare Artifacts repository contents, KV
     snapshot/bundle bodies, R2 object listings beyond
     `email_messages.raw_size`, or Vectorize: those stores either lack reliable
     byte metadata or are derived from D1 and are documented in
     `data-storage.md`.

**Account usage reporting:** `usageGet` and the account usage UI report the same
two storage components: authoritative D1 payload bytes from UserMeter plus the
latest non-null estimates in `user_storage_buckets`. A newly inventoried bucket
with no estimate contributes zero until the estimate-backfill lane or a
write-target probe records its first measurement. Enforcement remains more
conservative: it live-probes the bucket being written and every unmeasured
bucket, then adds those results to the D1 payload counter. Reporting can
therefore lag enforcement briefly. Account usage reporting includes
StorageRunner bucket estimates with the D1 payload counter. The two values are
not alternate D1 counters and do not change storage-limit semantics.

### Concurrency

Row-count limits are check-then-insert: the count query and the later insert are
separate statements, so a burst of concurrent creates can overshoot a limit by a
few rows before the next check sees the new count. That is an accepted trade-off
— these limits are order-of-magnitude denial-of-wallet caps, not billing-grade
accounting, and folding every insert into a conditional statement would couple
the entitlements module to each resource's write path. Daily rate-style limits
do not share this window: UserMeter consumes are serialized per user inside the
DO with revision-checked updates.

## How to add an enforcement point

The exemplar is package job sync: `syncPackageJobsForPackage` in
`packages/worker/src/jobs/service.ts`.

1. Find the service-layer function that **creates** the resource (enforce on
   creation, not updates), as early as possible — before any side effects like
   entity-source creation.
2. Make sure the acting user's `userId` **and** account email reach that
   function. Thread an explicit `userEmail` parameter if the service only
   receives only `userId`; MCP capabilities get it from
   `requireMcpUser(ctx.callerContext).email`, app handlers from the session
   user.
3. Call the single helper and let it throw:

```ts
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'

await assertWithinEntitlement({
	db: env.APP_DB,
	userId,
	email: userEmail,
	resource: 'scheduled_jobs',
	getCurrent: () =>
		jobsData(env).countJobsForUser({
			userId,
		}),
})
```

Pass `getCurrent` for any resource that is not APP_DB-countable
(`scheduled_jobs` via `jobsData`, `repo_sessions` via `RepoSessionIndex`,
workflows via RunLog, and similar).

4. If the resource is a new one, register it in `plans.ts`
   (`entitlementResources`, `PlanLimits`, `planLimits`,
   `entitlementResourceLabels`, `resolvePlanLimit`) and add a built-in counter
   in `service.ts` when it is D1-countable.
5. Test both sides: a plan user at the limit is denied with
   `details.code === 'entitlement_limit_exceeded'` (assert `resource`, `plan`,
   `limit`, `current`). Seed the test user's id with
   `testStableUserIdFromEmail(email)` (or any stored `stable_user_id`) and
   assert plan lookup against the email + stable-id pair; a mismatched pair must
   resolve as `free`.

## Enforcement points

| Resource                         | Enforcement point                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_jobs`                 | Full-addition preflight in `syncPackageJobsForPackage` in `packages/worker/src/jobs/service.ts` (package sync subtracts same-sync removals before checking, so replacements do not consume an extra slot). Free and public Standard also assert `minJobIntervalMs` (15 minutes); public Pro asserts 5 minutes. Existing faster jobs keep their schedule on identity-only refreshes. |
| `saved_packages`                 | new-package branch of `packageSave` and projection insert                                                                                                                                                                                                                                                                                                                           |
| `repo_sessions`                  | `repoOpenSession` before creating a new session                                                                                                                                                                                                                                                                                                                                     |
| `email_sends_per_day`            | `sendOutboundEmail` (`consumeDailyEntitlement`; plan limit from `resolvePlanLimit`)                                                                                                                                                                                                                                                                                                 |
| `email_receives_per_day`         | `handleInboundEmail` (`consumeDailyEntitlement`; same plan limits; refund only on `RetryableInboundStorageError`)                                                                                                                                                                                                                                                                   |
| `stored_email_messages`          | `handleInboundEmail` before storage (`assertWithinEntitlement`; `max` caps from `planLimits.max`). Users free slots with `emailMessageDelete` or the delete action on `/@<slug>/-/email` (Mailbox `deleteMessageWithBlobs`; count is live Mailbox `countMessages`)                                                                                                                  |
| `email_message_bytes`            | `handleInboundEmail` after inbound reduction (`assertWithinEntitlement` on kept raw size via `resolvePlanLimit`). Wire size above 25 MiB (`maxSurvivableInboundRawBytes`) rejects at SMTP. Mail between the persist cap and 25 MiB is reduced (text kept, oversized parts omitted) and stored.                                                                                      |
| `secrets`                        | new-entry branch of `saveSecret` in `packages/worker/src/mcp/secrets/service.ts`                                                                                                                                                                                                                                                                                                    |
| `concurrent_workflows`           | `createDynamicCallableWorkflow` (`reserveWorkflowProjectionSlot` + `assertWithinEntitlement` getCurrent; `max` = 5,000)                                                                                                                                                                                                                                                             |
| `execute_unique_workers_per_day` | executor capped claim from the MCP `execute` tool (`consumeExecuteUniqueWorkerDay` after the worker id is minted, before load; repeats free)                                                                                                                                                                                                                                        |
| `outbound_fetches_per_day`       | `executeGatewayFetch` (`consumeDailyEntitlement` before secret expansion)                                                                                                                                                                                                                                                                                                           |
| `job_runs_per_day`               | `executeJobOnce` (`consumeDailyEntitlement` before sandbox work; cron, interval, and run-now)                                                                                                                                                                                                                                                                                       |
| `automation_invocations_per_day` | `runSavedPackageModuleOnce` (`consumeDailyEntitlement` before sandbox for top-level webhook / package-export / subscription / workflow invokes; not nested execute or package-runtime invokes)                                                                                                                                                                                      |
| `storage_bytes`                  | UserMeter DO reserve via `assertWithinStorageBytesEntitlement` (atomic `reserveStorageBytes`; cold bootstrap via lazy per-owner physical reconcile, fail closed on scan errors; required `env.USER_METER`); StorageRunner write tools/app RPCs (`getCurrent` check-only for bucket component)                                                                                       |

## Billing

Optional Stripe subscription billing lives in `packages/worker/src/billing/`
(raw `fetch` client — no Stripe SDK; `STRIPE_API_BASE_URL` overrides the API
host for tests/mocks). Without `STRIPE_SECRET_KEY`, billing surfaces degrade to
manual plans only. `STRIPE_PRO_PRICE_ID` / `STRIPE_PRO_YEARLY_PRICE_ID`
independently enable checkout for the purchasable Pro ($12 / $120); an unset
price id only disables purchase of that interval. `retiredStandardPriceIds` /
`retiredProPriceIds` map the retired Standard ($12/$120, $5) and Pro ($49/$480
and earlier) price ids to `standard` / `pro` so existing subscribers keep their
plan; none of them is wallet-eligible.

Checkout sessions are created server-side for authenticated users via
`POST /@:orgSlug/-/billing/checkout.json` for the organization in the URL
(Stripe Checkout Session, JSON body
`{ plan: "pro", interval: "month" | "year", promoCode?: string }`,
`mode=subscription`, quantity = live seats (owners plus members, at least 1),
with a signed `client_reference_id` and `metadata.kody_org_id`). Only
`billing:write` (owners and billing admins) may call it; `/@<slug>/-/billing`
redirects to the signup organization's billing page. Sessions enable Stripe
automatic tax (`automatic_tax[enabled]`; Stripe Tax is active on the account and
computes 0 until a registration exists) and tax-ID collection for business
customers; when an existing `customer` is passed, `customer_update` address/name
are `auto` so Checkout can store what tax needs.

Sessions never set `allow_promotion_codes`. Stripe can restrict a coupon to a
product but not a price, and monthly and annual Pro are one product, so a
one-month code typed on Stripe's page would zero out a year. Customers type the
code on the Kody billing page instead
(`packages/worker/src/billing/checkout-promo.ts`): annual requests with a code
get 400 before any Stripe call, monthly codes are looked up
(`GET /v1/promotion_codes?code=…&active=true`), checked for expiry and
redemptions, and attached as `discounts[0][promotion_code]`. Codes are for new
subscriptions only; a customer with a plan-retaining subscription gets 409.
There is no public Payment Link path — checkout requires a signed-in session so
unauthenticated card-testing is not possible. `GET /@<slug>/-/billing/success`
verifies `client_reference_id` before linking `orgs.stripe_customer_id`, then
refreshes `orgs.stripe_plan` and renders a thank-you page (Discord invite;
connect-your-agent when `needsOnboarding`). A successful `stripe_plan` write
also best-effort re-syncs official Kody Discord Standard/Pro roles when the user
has a Discord social-login connection (see
[`social-login.md`](../social-login.md)). `GET /@<slug>/-/billing/portal` opens
the Stripe customer portal for linked customers, pinned to
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID` when set.

**Plan changes for existing subscribers never create a second subscription.**
When the checkout handler finds a linked `stripe_customer_id`, it lists the
customer's subscriptions and keeps the plan-retaining ones (`active` /
`trialing` / `past_due`, the same set `resolveSubscriptionPlan` grants from).
With exactly one, it creates a Billing Portal session with
`flow_data[type]=subscription_update_confirm` that moves that subscription's
item to the requested Pro price (prorated with `always_invoice`) and returns
`{ ok: true, url, mode: 'portal_update' }`; Stripe redirects back to
`/@<slug>/-/billing?billing=updated` after the customer confirms the prorated
change. Requesting the price the subscription already has returns
`409 { error: 'You are already on that plan.' }`. More than one plan-retaining
subscription (legacy double subscriptions) returns the plain portal with
`mode: 'portal'` so the customer chooses which to keep. Only customers with no
plan-retaining subscription (or no customer at all) get a Checkout Session
(`mode: 'checkout'`). The billing page labels these buttons "Switch to …
(prorated)", and `loadAccountBillingData` reports `stripeInterval` (from the
configured monthly/yearly price ids) so the current tier can offer the other
interval. The `?billing=updated` page view runs the usual on-view refresh and
arms the `StripePlanRefresh` backstop; `customer.subscription.updated` webhooks
refresh the plan independently.

### Account deletion refunds

Account deletion is the one automatic refund path (the Terms of Service say so).
Before the destructive steps, `deleteUserAccount` refunds the unused remainder
of the current period for each `active` or `trialing` subscription and then
cancels it immediately; dunning, paused, and incomplete subscriptions are
canceled without a refund. The client helpers are
`listPaidInvoicesForSubscription`
(`GET /v1/invoices?subscription=… &status=paid&limit=10`, walked newest first to
the invoice that still covers the period), `listCreditNotesForInvoice` (retry
idempotency, keyed on the `kody_account_deletion=1` metadata marker),
`listCreditNotesForCustomer` (so the deletion report includes notes from earlier
attempts), and `createProratedRefundCreditNote`, which previews then creates one
credit note with a `lines[n][type]=invoice_line_item` / `lines[n][amount]` entry
per eligible invoice line and `refund_amount` equal to the previewed total. Line
amounts are gross (pre-discount, tax-exclusive) like the invoice line's own
`amount`; Stripe prorates each line's discounts and tax into the credit note and
refunds that total to the original payment method. The prorated amount per line
is `floor(lineAmount * (period.end - now) / (period.end - period.start))`. The
refund is hard-capped at
`maxRefundMinor = invoice.amount_paid − Σ total of every issued credit note on the invoice (any issuer)`:
a mid-cycle upgrade invoice (portal upgrades bill with `always_invoice`) has a
positive new-plan line plus a negative unused-time credit for the old plan, so
`amount_paid` is the net and the positive line's unused fraction alone can
exceed it. Both credit note listings follow `has_more` / `starting_after` to the
end (up to `creditNoteListMaxPages` = 20 pages of 100); a listing still
reporting more after that throws `StripeCreditNoteListIncompleteError`, which
the refund path treats as an unknown remainder and therefore a cap of zero. A
cap of zero or less means nothing to refund; while the preview exceeds the cap
every line is scaled by `cap / previewedTotal` (floored, integer arithmetic —
the gross lines and the net, tax-inclusive preview only ever meet as a ratio)
and previewed again, up to `creditNoteCapFitAttempts` = 6 times. If it still
does not fit, `createProratedRefundCreditNote` returns `unfittable` and the
deletion logs `account_deletion_refund_unfittable`, audits
`account_deletion_refund_skipped`, and cancels without refunding that invoice (a
missing refund on a rounding edge is a support ticket; a blocked deletion is a
broken promise). Any other refund failure is a billing failure
(`AccountDeletionBillingError`): the account is retained for retry, exactly like
a failed cancel; only a preview that totals zero or a charge Stripe reports as
already fully refunded is treated as "nothing to refund". A rejected create is
logged as `account_deletion_refund_rejected` with the subscription and invoice
ids, the amount paid, the cap, and the requested amount (no PII). The full
sequence, skip conditions, audit action, and result shape are documented with
the rest of the deletion flow in
[`data-storage.md`](./data-storage.md#account-deletion-inventory).

### Webhooks (primary sync)

`POST /webhooks/stripe` is the primary path for linking customers and refreshing
plans when Stripe subscription state changes. It is unauthenticated and verifies
the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET` (HMAC-SHA256 over
`${t}.${rawBody}`; ~300s timestamp tolerance). When the secret is unset, the
endpoint returns 503.

Handled event types:

- `checkout.session.completed` — resolve the user via `client_reference_id`
  matching `createBillingLinkReference` (candidates from
  `metadata.kody_stable_user_id`, existing `stripe_customer_id`, or customer
  email), then run the same link+refresh helper as the success redirect
- `customer.subscription.updated` / `customer.subscription.deleted` — look up
  the user by `orgs.stripe_customer_id` and call `refreshStripePlanForUser`
- `invoice.payment_failed` — same customer lookup + refresh (surfaces
  `subscriptionStatus` such as `past_due` for UX; does not email users)
- `invoice.paid` — customer lookup, then the referral reward path when the
  invoice is the referee's first qualifying paid subscription invoice
- `checkout.session.completed` with `metadata.kody_credit_top_up=1` — credits
  the prepaid wallet instead of linking a subscription (see
  [Prepaid credits](#prepaid-credits))
- Unknown event types — acknowledge `200` after process+record

Idempotency uses the `stripe_webhook_events` table from
`packages/worker/migrations/0001-squashed-init.sql`
(`stripe_webhook_events.event_id` unique). Events are processed first (handlers
are idempotent), then recorded. A UNIQUE conflict after a successful process is
treated as duplicate success (`200`). Process failures return `500` without
inserting so Stripe can retry. Rows older than 30 days are pruned by retention.

### Activity-driven backup

Billing refresh is activity-driven; there is no global hourly customer scan.
Checkout completion and subscription/invoice webhooks refresh immediately and
also arm the owning user's one-shot `StripePlanRefresh` Durable Object alarm for
one hour later. That independent retry closes over transient Stripe failures
without repeatedly enumerating inactive users. `/@<slug>/-/billing` arms the
same backstop and still refreshes on every view so non-persisted `cancel_at` /
`subscriptionStatus` stay current. If checkout cannot arm its backstop, a failed
immediate refresh remains an error so the caller or Stripe webhook retries
instead of acknowledging an unrecoverable stale projection. The
`stripe_customer_id` (unique partial index), `stripe_plan`, and
`stripe_plan_refreshed_at` columns ship in the squashed baseline;
`stripe_price_id` ships in `0044-users-stripe-price-id.sql`. The alarm DO class
exists without moving canonical billing data out of D1.

Published prices: Free $0, Pro $12/mo or $120/year ($10/mo billed annually) with
prepaid credits. Retired Standard ($12/$120) and Pro ($49/$480) continue for
existing subscribers only. Env vars and deploy wiring are documented in
[`../environment-variables.md`](../environment-variables.md).

## Related tables and coordination

- `orgs.plan` — NOT NULL DEFAULT `'free'` (squashed baseline plus the 0002 tier
  rename). The entitlements module is the consumer of that column (manual /
  admin grant).
- `orgs.stripe_customer_id`, `orgs.stripe_plan`, `orgs.stripe_price_id`,
  `orgs.stripe_plan_refreshed_at` — Stripe billing columns owned by
  `packages/worker/src/billing/`, read by `getUserEntitlement` via
  `resolveEffectivePlan`. `stripe_plan` stays nullable because it is
  Stripe-derived; `max` is manual-only. `stripe_price_id` is the granting
  configured or retired price so a later refresh can drop `legacy` when the
  subscription changes.
- `orgs.entitlement_ladder` — `'public'` or `'legacy'`. Owned with the
  entitlements module; Stripe refresh clears `legacy` when paid access ends or
  the granting subscription changes plan, price, product, or interval. Admin
  plan writes clear `legacy` when a remaining manual Pro grant is removed
  without a paid Stripe tier.
- `orgs.referral_standard_credit_expires_at` and `referrals` — uncapped referral
  program ledger. Attribution is persisted at signup from the last-wins
  `kody_ref` cookie; reward is invoice-gated. See
  [Referral Pro credit](#referral-pro-credit).
