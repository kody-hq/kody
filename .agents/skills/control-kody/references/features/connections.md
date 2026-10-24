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
- `/account/connected-apps`: Sign in with Kody app grants (with what each app
  may do) and connected agents across every org, each with Revoke. Seed a grant
  locally with `local-app-db` (`package_app_oauth_grants`) to see a row.
  `npm run control-kody -- request GET /account/connected-apps --contains 'Connected apps'`
