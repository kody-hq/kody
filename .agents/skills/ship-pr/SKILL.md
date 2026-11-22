---
name: ship-pr
description: >
  Babysit a PR to done with the @kody/kody-factory ship-pr tick: tick the PR,
  read the focused step, fix / reply / decide, and tick again until done (merge
  or park, deploy, leftover friction, Discord summary). Use when a pull request
  needs to be shepherded to done.
---

```bash
npx @kodycodes/cli execute --local --org kody \
  --code 'import run from "kody:@kody/kody-factory/ship-pr/tick"; export default (p) => run(p)' \
  --params '{
    "prUrl": "https://github.com/OWNER/REPO/pull/N",
    "risk": "medium",
    "applySafeAutomations": true
  }'
```

If the CLI says `No login stored for org "kody"`, add a kody org login: on the
kody org MCP connection call `cliCredentialBootstrap` and run the `cli_command`
it returns (see
[prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md)), or run
`npx @kodycodes/cli login --org kody`. That login becomes the default org, so
pass `--org <your-org>` for packages in your personal org.

Follow what it returns, re-ticking until `exit.done`. The PR also shows up as a
card on the factory board, so anyone can see where it is.

The old `kody:@kentcdodds/ship-pr/tick` (run without `--org kody`) still works
and takes the same params. Use it if the factory tick errors, and file friction
on `@kody/kody-factory`.

- **Risk:** pick `low`, `medium`, or `high` yourself. High means auth, secrets,
  billing, data migrations, destructive changes, or anything hard to undo.
- **Merge:** auto-merge low and medium once CI is green and valid reviewer
  feedback is handled. High waits for Kent unless he explicitly said to merge.
- **Migrations:** right before merging a PR that adds files under
  `packages/worker/migrations/`, run
  `git fetch origin main && node tools/check-migration-prefix-against-main.ts`.
  PR CI compares against the merge base, so a prefix another PR already took on
  `main` merges green and then fails main Validate. If it fails, rename the
  migration and its ledger entry, push, and wait for CI before merging.
