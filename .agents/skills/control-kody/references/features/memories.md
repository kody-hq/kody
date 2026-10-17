# Memories

Durable **personal** facts (ADR 0072). Always stored on the person's personal
org, regardless of which org the connection uses. Verify-first writes
(`metaMemoryVerify` before upsert/delete). Ask before copying a personal memory
into an org package. Team workspaces hide Memories from the nav; a direct team
URL shows a retired notice.

## How to get there

Personal: `/@<slug>/-/memories` → `/@<slug>/-/memories/:memoryId`.

Personal org only (writable). Team org: no Memories nav item.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/memories
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

The download protocol remains `GET /account/memories-export.json`.

## Gotchas

- MCP instruction overlay is not memory. Do not store package inventory there.
- Shared org knowledge belongs in documented packages and org instructions, not
  memory.
