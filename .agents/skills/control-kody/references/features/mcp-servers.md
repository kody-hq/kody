# MCP servers

User-added MCP servers and the OAuth clients they mint.

## How to get there

`/@<slug>/-/mcp-servers` → `/@<slug>/-/mcp-servers/new` →
`/@<slug>/-/mcp-servers/:serverId`. Clients: `/account/mcp-oauth-clients`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/mcp-servers
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

The external OAuth callback remains `/account/mcp-servers/oauth/callback`.

## Gotchas

- App `/mcp` (Kody-as-server) is a different surface. Unauthenticated GET is 401
  by design.
- After IdP success, Status on `/@<slug>/-/mcp-servers/:serverId` shows a
  sanitized last settle error when tool discovery does not finish (including
  after a 2025 handshake retry). When a ready connection parks on
  `authenticating`, Status and `mcpServerList.error` include the sanitized
  token-refresh reason. `mcpServerList` also reports `hasRefreshToken`.
  Reconnect tries the stored tokens first, then mints a new authorization link.
  Reconnect from that page.
