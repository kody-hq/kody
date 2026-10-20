---
name: ship-pr
description: >
  Babysit a PR to done with the @kentcdodds/ship-pr Kody package: tick the PR,
  read the focused step, fix / reply / decide, and tick again until done (merge
  or park, deploy, leftover friction, Discord summary). Use when a pull request
  needs to be shepherded to done.
---

# Ship PR

When a pull request needs to be shepherded to done. The loop is the Kody package
`@kentcdodds/ship-pr` (`search({ entity: "package:@kentcdodds/ship-pr" })`).
Change behavior in the package, not here.

Pass `risk` on every tick. User policy overrides.

- **low:** green CI. AI review is optional.
- **medium:** wait for Bugbot. Handle valid feedback. If `triggerBugbot` returns
  `github_account_mismatch` (or `posted: false` with that code), do **not** wait
  for Bugbot — none will appear. Proceed with CI (and CodeRabbit only when high
  risk or the user asks).
- **high:** also wait for CodeRabbit and Devin. Park unless `mergeAuthority` is
  true.

Credential setup is
[prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md).

## Devin PRs

Same loop. Differences: Devin PRs are usually authored by
`devin-ai-integration[bot]`, so Bugbot often returns `github_account_mismatch`
and that skip is the common path. Verify locally with
[control-kody](../control-kody/SKILL.md) first; treat a verified preview deploy
as a merge gate only when local cannot exercise the change (Workers/service
bindings, Durable Objects, real OAuth or inbound third-party webhooks,
deploy/wrangler/config, the real remote Artifacts namespace) — exercise the
changed surface, not only a 200. For non-previewable changes, run the applicable
static checks for the changed surface instead; for time gates, wake the Devin
session via `kody:@kentcdodds/devin/sessions` `sendMessage` instead of Cursor
`createRun`.

## Command

The CLI rejects `--local` together with `--invoke`. Use the static import tick
prints in `exampleInvokes`. The first tick is full. Re-ticks pass `brief: true`.

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/tick"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kody-hq/kody/pull/123","risk":"medium","applySafeAutomations":true}'
```

## Failure

- `exit.status` is `waiting`. Do **not** tight-loop. End the turn only after
  arming **both** (1) the relevant GitHub CI subscription when waiting on CI,
  and (2) a one-shot Cursor `subscribe_timer` from `exit.wakeHints` (name,
  `delaySeconds`, `once: true`, `prompt`). CI subscriptions can miss a delivery;
  without the timer a green PR can sit unmerged for hours (#3750 / #3746). On
  timer wake: re-tick; if still `waiting`, re-arm from the new `exit.wakeHints`.
  Blocked on soak / parity / calendar gates the same way — schedule a wake; do
  not sleep-poll.
- A check or bot finding you will not fix: `./decide` with a reason (`ignored`,
  `skipped`, `wontfix`, or `accepted`).
- A valid finding: fix, push, and `./reply-review` with `Fixed in <sha>: ...`.
- Focus `merge`: `./merge`. Focus `friction`:
  [file-friction](../file-friction/SKILL.md). Focus `report`: the printed
  `./send-summary`. Take `agentId` and `model` from the agent socket. Omit
  `model` when the socket has none. Do not invent URLs. When UI routes deployed,
  put verified page links in Discord `extras`.
- This repo, medium or high: verify locally with
  [control-kody](../control-kody/SKILL.md) (`dev`/`login`/`request`/`browse`/
  `execute`). Use a PR preview only when local cannot exercise the change
  (Workers/service bindings, Durable Objects, real OAuth or inbound third-party
  webhooks, deploy/wrangler/config, the real remote Artifacts namespace). PR
  bodies say `Related to #N`, never `does not close #N`. Non-trivial
  descriptions include a system recap
  ([visual-recap](../visual-recap/SKILL.md)).
- Reviewers must scrutinize test-expectation / assertion changes made in the
  same PR as the code they test, and push back when an assertion was rewritten
  to match a behavior change without justification.
