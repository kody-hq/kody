# Experiments

Account opt-in for early, unfinished work. Puts the signed-in user in the
feature-flag `experiments_opt_in` audience. Does not enable any experiment by
itself.

## How to get there

`/account/experiments` after login. Also listed on the account rail.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /account/experiments
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

## Gotchas

- Opt-in only membership. Operators still enable each flag globally (and may set
  Audience to “Experiments opt-in” at `/admin/feature-flags` or via
  `adminFeatureFlagSet({ audience: "experiments_opt_in" })`).
- Per-user flag overrides win over the audience gate (operator dogfood without
  the account page).
- This page is unrelated to Jev search enablement; do not assume
  `jev-search-rerank` is on after opt-in.
