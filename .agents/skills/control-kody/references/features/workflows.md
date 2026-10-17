# Workflows

Deferred one-shot runs (`workflows.create({ runAt })`).

## How to get there

`/@<slug>/-/workflows` → `/@<slug>/-/workflows/:workflowId`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/workflows
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

## Gotchas

- Recurring work belongs on `kody.jobs`, not workflows.
- A displayed `inline-code` name on `/@<slug>/-/workflows` and Activity shows
  the idempotency key as a subtitle.
