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

Run every follow-up tick suggests (`decide`, `reply-review`, `reply-comment`,
`review-sort`, `merge`) from `kody:@kody/kody-factory/ship-pr/*` with
`--org kody`. The factory has no `send-summary` yet; send the summary with
`kody:@kentcdodds/ship-pr/send-summary` (Remove when: `@kody/kody-factory`
publishes `./ship-pr/send-summary`, #5420). Decisions live in the package that
recorded them, so a `kody:@kentcdodds/ship-pr/decide` call is invisible to the
factory tick and leaves it stuck. If the factory tick errors, the old
`kody:@kentcdodds/ship-pr/*` (run without `--org kody`, same params) still
works: run the whole loop there, and file friction on `@kody/kody-factory`.

- **Risk:** pick `low`, `medium`, or `high` yourself. High means auth, secrets,
  billing, data migrations, destructive changes, or anything hard to undo.
- **Merge:** auto-merge low and medium once CI is green and valid reviewer
  feedback is handled. High waits for Kent unless he explicitly said to merge.
