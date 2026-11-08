# Billing, credits, and usage

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/usage --contains 'Usage'
npm run control-kody -- request GET /@jane/-/billing --contains 'Billing'
```

Stripe checkout / webhooks need preview or production-like config.

## Assert

- `/@{$orgSlug}/-/billing`, `/@{$orgSlug}/-/billing/success`,
  `/@{$orgSlug}/-/billing/move-plan`, `/@{$orgSlug}/-/credits`,
  `/@{$orgSlug}/-/usage`
- Owner of two orgs: **Move this plan to another organization** on billing when
  the source pays for Pro through Stripe (no manual plan), is credit-eligible,
  and is not scheduled to cancel. A subscription with a cancel date hides the
  link (`guide:organizations` § Move a Pro plan)
- Legacy `/account/billing`, `/account/credits`, `/account/usage` redirect to
  the personal org
