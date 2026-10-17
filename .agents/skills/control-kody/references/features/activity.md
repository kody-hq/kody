# Activity

User-level execution history (jobs, execute, webhooks, apps).

## How to get there

`/@<slug>/-/activity` → `/@<slug>/-/activity/:runId`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/activity
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

## Gotchas

- This is not the waiting inbox. Waiting is human-action items; activity is run
  history.
- Workflow runs named `inline-code` show the idempotency key as a subtitle.
