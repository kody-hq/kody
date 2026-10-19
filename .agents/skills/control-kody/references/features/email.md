# Email inbox

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/email --contains 'Email'
```

Inbound mail from third parties needs a preview / production-like environment.

## Assert

- `/@{$orgSlug}/-/email`, `/@{$orgSlug}/-/email/$messageId`
- Legacy `/account/email`
