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
- In a team org, This machine setup is staged: sign in as the person, register
  personally, make available to the team, runner connected. Manage setup
  attaches an existing personal registration (no second registration) and puts
  it first in that org's chain, keeping the personal chain and the org's other
  entries. Resume setup continues from the last completed stage; success waits
  until the team chain lists the machine
- Desktop-only This machine controls always offer Set up / Resume / Manage setup
  (and explain when the wizard is unavailable), plus pause/resume and forgetting
  local setup. Forgetting does not revoke the device or remove its chain entry
- OAuth/device consent locks the org chooser when the client already required an
  org (`?org=` / requested org), with an explanation; mismatch rejection stays
- Kody cloud stays last in the chain and cannot be dragged
- Context detail Daemon card (`context-daemon`): Pause/Resume, Restart, Update
  now, and View recent log (operator only, at most 500 lines). A paused context
  shows who paused it and why; `kody chain` marks it `[paused]` and runs skip it
  with routing outcome `paused`
- Org owners/admins can pause (never resume) any context attached to the org
