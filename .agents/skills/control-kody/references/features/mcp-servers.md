# MCP servers

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/mcp-servers --contains 'MCP'
```

## Assert

- `/@{$orgSlug}/-/mcp-servers`, `/account/mcp-servers`,
  `/account/mcp-oauth-clients`
- OAuth callback: `/account/mcp-servers/oauth/callback`
