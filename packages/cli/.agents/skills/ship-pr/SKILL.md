---
name: ship-pr
description: >
  Babysit a PR: iterate with AI reviewers and CI until green, get it ready,
  optionally squash-merge as Kody and watch the publish, then send a Discord
  summary. Medium risk waits for AI reviewer(s) and addresses valid feedback.
  Use when a pull request needs to be shepherded to done.
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

Follow what it returns, re-ticking until `exit.done`. The PR also shows up as a
card on the factory board, so anyone can see where it is.

The old `kody:@kentcdodds/ship-pr/tick` (run without `--org kody`) still works
and takes the same params. Use it if the factory tick errors, and file friction
on `@kody/kody-factory`.

- **Risk:** pick `low`, `medium`, or `high` yourself. High means auth, secrets,
  billing, data migrations, destructive changes, or anything hard to undo.
- **Merge:** auto-merge low and medium once CI is green and valid reviewer
  feedback is handled. High waits for Kent unless he explicitly said to merge.
