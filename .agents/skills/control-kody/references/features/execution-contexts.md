# Execution contexts

Behind the `execution-contexts` feature flag (audience `experiments_opt_in`).

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/execution-contexts --contains 'Execution contexts'
```

With the flag off the page shows the opt-in callout. Turn it on for the local
user from `/account/experiments` or the callout's Try button. Register a context
with `kody context register --name my-machine` against the local origin to see a
non-empty list.

## Assert

- `/@{$orgSlug}/-/execution-contexts`,
  `/@{$orgSlug}/-/execution-contexts/$contextId`
- Legacy `/account/execution-contexts` redirects to the personal org
- Rail item sits in Build right after Jobs, only with the flag on, and never for
  grant-only collaborators
- A new registration shows "Not in any chain" and is never added to a chain
- Kody cloud stays last in the chain and cannot be dragged
