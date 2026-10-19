# Workflows

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/workflows --contains 'Workflows'
```

## Assert

- `/@{$orgSlug}/-/workflows`, `/@{$orgSlug}/-/workflows/$workflowId`
