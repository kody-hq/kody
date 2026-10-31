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
- Rail item sits in Build right after Jobs with an Experiment badge, and never
  for grant-only collaborators
- CLI registration alone does not change a chain
- Desktop setup adds the verified personal machine first, preserving other
  entries and cloud fallback. A full chain requires an explicit replacement
- Desktop-only This machine controls support setup, pause/resume, and forgetting
  local setup. Forgetting does not revoke the device or remove its chain entry
- Kody cloud stays last in the chain and cannot be dragged
