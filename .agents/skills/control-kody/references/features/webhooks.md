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
- Apply approval: `/connect/webhook-apply` (one Approve per endpoint)
- Package settings webhooks panel: `/@{$username}/$kodyId/settings`
- GET/POST `webhooks.json` returns one card per endpoint. Mint on an unminted
  name creates the first URL. An already-minted name without `createInstance` is
  400 (rotate, or mint another labeled URL). `Mint another URL` posts
  `createInstance` plus optional `instanceLabel`; rotate/enable/disable take
  `endpointId`. URLs and IDs stay behind Details.
