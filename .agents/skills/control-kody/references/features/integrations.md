# Integrations and OAuth connect

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/integrations --contains 'Integrations'
```

Real third-party OAuth needs a preview (or production-like) environment.

## Assert

- `/@{$orgSlug}/-/integrations`, `/connect/oauth`
- Marketing pages: `/integrations/gmail`, `/integrations/slack`,
  `/integrations/claude` (logos are `asset` kind)
