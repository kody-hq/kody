# Jobs

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/jobs --contains 'Jobs'
```

Create a job via `execute` / MCP when asserting non-empty list.

## Assert

- `/@{$orgSlug}/-/jobs`, `/@{$orgSlug}/-/jobs/$jobId`
- Legacy `/account/jobs` redirects to the personal org
