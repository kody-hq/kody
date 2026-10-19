# Webhooks

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/webhooks --contains 'Webhooks'
```

Minted ingress URLs live under
`/@{$username}/webhooks/$packageKodyId/$webhookName/$urlSecret`. Inbound Stripe:
`/webhooks/stripe` (needs real Stripe — preview only).

## Assert

- Index: `/@{$orgSlug}/-/webhooks`, `/account/webhooks`
- Apply approval: `/connect/webhook-apply`
- Package settings webhooks panel: `/@{$username}/$kodyId/settings`
