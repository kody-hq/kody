# Waiting inbox

Things waiting on the signed-in human (first-use setup, approvals, reconnects,
expired secrets, publish locks). Fold connection-health here — do not invent
another inbox.

## How to get there

`/@<slug>/-/waiting`. Not a notifications product — fold connection-health and
approve-publish here instead of inventing another inbox.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/waiting
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

## Gotchas

- Seed accounts usually still show first-use setup cards (search, memory,
  execute, package, job, integration, secret, Discord) until those gates clear.
  Empty is only after those plus reconnects and locks are gone. Create the
  pending grant or locked package through supported MCP capabilities or the UI
  before asserting copy.
- The error-rate card counts **open** Activity errors in the last 7 days.
  Ignored and resolved runs do not keep it on Waiting.
