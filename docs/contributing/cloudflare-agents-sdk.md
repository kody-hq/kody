# Cloudflare Agents SDK (`agents`)

This repo uses the Cloudflare Agents SDK (`agents` npm package) for Durable
Object–backed MCP server and client surfaces. Upstream docs:
https://developers.cloudflare.com/agents/

The installed version is pinned in `packages/worker/package.json`.

## Quick pointers for this repo

- MCP HTTP `/mcp` is served by origin (`packages/worker/src/index.ts` via
  `MCP.serve(...)`). The `MCP` Durable Object class (`McpAgent` in
  `packages/worker/src/mcp/index.ts`) is owned by `kody-platform`.
- Capabilities exposed through the compact `search` / `execute` tools are
  registered per-domain (`packages/worker/src/mcp/capabilities/*/domain.ts`) and
  merged in `packages/worker/src/mcp/capabilities/builtin-domains.ts`; see
  [adding capabilities](./adding-capabilities.md).
- This project is not organized around the React hook APIs from the SDK; for
  non-React clients, use `AgentClient` from `agents/client`.

## Imports used here

| Import path                           | Used for                                                     |
| ------------------------------------- | ------------------------------------------------------------ |
| `agents/mcp`                          | `McpAgent` DO class (`packages/worker/src/mcp/index.ts`)     |
| `agents/mcp/client`                   | `MCPClientManager` (`packages/worker/src/mcp-client/hub.ts`) |
| `agents/mcp/do-oauth-client-provider` | OAuth client provider for MCP connections                    |
| `agents/lifecycle`                    | Connection lifecycle in the MCP client hub                   |

For Durable Object + SQLite setup, routing, and other SDK surfaces, use the
upstream
[API reference](https://developers.cloudflare.com/agents/api-reference/) rather
than a mirrored module dump in this repo.
