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
  `/@{$orgSlug}/-/credits`, `/@{$orgSlug}/-/usage`
- Legacy `/account/billing`, `/account/credits`, `/account/usage` redirect to
  the personal org
