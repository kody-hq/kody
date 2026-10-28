---
name: ship-pr
description: >
  Babysit a PR: iterate with AI reviewers and CI until green, get it ready,
  optionally squash-merge as Kody and watch the publish, then send a Discord
  summary. Medium risk waits for AI reviewer(s) and addresses valid feedback.
  Use when a pull request needs to be shepherded to done.
---

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)' \
  --params '{
    "prUrl": "https://github.com/OWNER/REPO/pull/N",
    "risk": "medium",
    "applySafeAutomations": true
  }'
```

Follow what it returns, re-ticking until `exit.done`.

- **Risk:** pick `low`, `medium`, or `high` yourself. High means auth, secrets,
  billing, data migrations, destructive changes, or anything hard to undo.
- **Merge:** auto-merge low and medium once CI is green and valid reviewer
  feedback is handled. High waits for Kent unless he explicitly said to merge.
