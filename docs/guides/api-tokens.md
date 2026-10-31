---
id: api_tokens
title: 'API tokens (API keys): list, revoke, delete, rotate'
summary:
  List, inspect, rotate, and revoke your Kody API tokens (kody_at_ API keys)
  with tokenList / tokenGet / tokenRotate / tokenRevoke. These are Open API
  operations, reachable from the MCP api tool, HTTPS, or `kody api`, not from
  execute.
category: platform
---

# API tokens (API keys)

Kody API tokens (`kody_at_…`, sometimes called API keys) authenticate the
[Open API](./open-api.md), the CLI, and CI. There is no account UI for them: you
manage them with these Open API operations.

| Task                     | `operationId`        | Needs scope    |
| ------------------------ | -------------------- | -------------- |
| List your tokens         | `tokenList`          | `token:read`   |
| Inspect one token        | `tokenGet`           | `token:read`   |
| Revoke a token           | `tokenRevoke`        | `token:delete` |
| Rotate a token           | `tokenRotate`        | `token:delete` |
| Mint a token             | `tokenCreate`        | none           |
| Revoke the calling token | `tokenRevokeCurrent` | none           |

Scopes apply when the caller is itself an API token. The MCP `api` tool runs as
you, so it can list and revoke any of your tokens.

## Revoke a token

1. List tokens and find the one to revoke by `name`, `scopes`, or
   `last_used_at`:

   ```json
   { "operationId": "tokenList" }
   ```

2. Revoke it by `id` (the part after `kody_at_` and before `_`):

   ```json
   { "operationId": "tokenRevoke", "params": { "token_id": "<id>" } }
   ```

Revoking is how you delete a token. Revocation is immediate. Anything still
using the token gets `401 API token was revoked.`

## Where to call these

- **MCP `api` tool** (preferred for connected agents): pass the JSON above.
- **CLI**: `npx @kodycodes/cli api tokenList` and
  `npx @kodycodes/cli api tokenRevoke --params '{"token_id":"<id>"}'` after
  `npx @kodycodes/cli login` (see [Local CLI execute](./local-execute.md)).
- **HTTPS**: `GET /v1/tokens` and `DELETE /v1/tokens/{token_id}` on
  [api.kody.codes](https://api.kody.codes) with a token that holds `token:read`
  / `token:delete`.

Token operations are not `kody.*` capabilities, so `execute` (hosted or
`--local`) cannot call them, and `search` lists this guide rather than a
capability.

## Only `search` and `execute` in your tool list?

Kody's MCP server advertises `search`, `execute`, and `api` to every signed-in
account on every plan; nothing gates `api` by tier, scope, or client. If your
agent only sees `search` and `execute`, its MCP client is showing a tool list
cached from an earlier connection. Refresh the Kody server's tools in the client
(reconnect it, or restart the client) and `api` appears. Until then, use the CLI
commands above.
