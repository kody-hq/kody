# Agents (connected agents)

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/agents --contains 'Agents'
```

Local personal org slug is typically the seed username (`user-me` on preview,
`jane` locally — check `/session`). Old `/@<slug>/-/connections` URLs 301 to
agents.

## Assert

- `/@{$orgSlug}/-/agents`, `/@{$orgSlug}/-/agents/new`
- Legacy redirects: `/account/agents`, `/account/connections`,
  `/@{$orgSlug}/-/connections`
